const crypto = require('crypto');
const config = require('./config');
const supabaseService = require('./supabaseService');
const intelligenceService = require('./intelligenceService');
const prompts = require('./prompts');
const { GoogleGenAI } = require('@google/genai');
const WhatsAppCloudService = require('./whatsappCloudService');

const { screeningPrompt } = prompts;

/**
 * Webhook Handler for WhatsApp Cloud API
 * Receives and processes incoming messages and events
 */

class WebhookHandler {
    constructor() {
        this.messageCache = {}; // Store messages temporarily for processing
        this.whatsappServices = {}; // Map of employeeId to WhatsAppCloudService instances
    }

    /**
     * Register a WhatsApp service instance for an employee
     */
    registerService(employeeId, whatsappService) {
        this.whatsappServices[employeeId] = whatsappService;
    }

    /**
     * Get service for an employee
     */
    getService(employeeId) {
        return this.whatsappServices[employeeId] || this.whatsappServices['default'];
    }

    /**
     * Handle webhook GET request (for verification during setup)
     */
    async handleVerification(req, res) {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
            console.log('✅ Webhook verified successfully');
            return res.status(200).send(challenge);
        }

        console.error('❌ Webhook verification failed');
        return res.sendStatus(403);
    }

    /**
     * Verify webhook signature for security
     */
    verifySignature(req) {
        const signature = req.get('x-hub-signature-256');
        if (!signature || !config.WHATSAPP_APP_SECRET) {
            console.warn('⚠️ Signature verification skipped (missing header or secret)');
            return true; // Skip if secret not configured
        }

        const payload = req.rawBody || JSON.stringify(req.body);
        const hash = crypto
            .createHmac('sha256', config.WHATSAPP_APP_SECRET)
            .update(payload)
            .digest('hex');

        const expectedSignature = `sha256=${hash}`;
        return expectedSignature === signature;
    }

    /**
     * Handle webhook POST request (incoming messages and events)
     */
    async handleWebhookPost(req, res) {
        // Verify signature
        if (!this.verifySignature(req)) {
            console.error('❌ Invalid webhook signature');
            return res.sendStatus(403);
        }

        const body = req.body;

        // Acknowledge receipt immediately
        res.sendStatus(200);

        if (!body.entry || !body.entry[0]) {
            console.log('ℹ️ Webhook received but no entry');
            return;
        }

        const changes = body.entry[0].changes || [];

        for (const change of changes) {
            if (change.field === 'messages') {
                await this.handleMessageEvent(change.value);
            } else if (change.field === 'message_template_status_update') {
                await this.handleTemplateStatusUpdate(change.value);
            } else if (change.field === 'message_template_quality_update') {
                await this.handleTemplateQualityUpdate(change.value);
            }
        }
    }

    /**
     * Process incoming message event
     */
    async handleMessageEvent(messageData) {
        if (!messageData || !messageData.messages) return;

        const messages = messageData.messages || [];
        const contacts = messageData.contacts || [];
        const metadata = messageData.metadata || {};

        // Get phone number from metadata
        const phoneNumberId = metadata.phone_number_id || config.WHATSAPP_PHONE_NUMBER_ID;

        for (const msg of messages) {
            try {
                await this.processIncomingMessage(msg, contacts, phoneNumberId);
            } catch (err) {
                console.error('❌ Error processing message:', err.message);
            }
        }
    }

    /**
     * Process a single incoming message
     */
    async processIncomingMessage(msg, contacts, phoneNumberId) {
        const senderId = msg.from;
        const messageId = msg.id;
        const timestamp = new Date(msg.timestamp * 1000);

        // Get sender name from contacts
        const senderContact = contacts.find(c => c.wa_id === senderId);
        const senderName = senderContact?.profile?.name || senderId;

        console.log(`📨 Message from ${senderName} (${senderId}): ${messageId}`);

        // Mark message as read
        if (this.getService('default')) {
            try {
                await this.getService('default').markAsRead(messageId);
            } catch (e) {
                console.warn('⚠️ Could not mark message as read');
            }
        }

        // Handle different message types
        let messageData = {
            messageId,
            sender: senderName,
            senderNumber: senderId,
            timestamp: timestamp.toISOString(),
            phoneNumberId,
            format: 'unknown',
            messageDetails: '',
            action: 'NEW'
        };

        if (msg.type === 'text') {
            const text = msg.text?.body || '';
            messageData.format = 'text';
            messageData.messageDetails = text;

            // Handle critical commands
            await this.handleCriticalCommands(text, senderId, phoneNumberId);
        } else if (msg.type === 'image') {
            messageData.format = 'photo';
            messageData.messageDetails = msg.image?.caption || '[Image]';

            // Download and process image
            try {
                const mediaBuffer = await this.getService('default').downloadMedia(msg.image.id);
                messageData.buffer = mediaBuffer;
                messageData.mimeType = 'image/jpeg';

                const supabaseBuffer = Buffer.from(mediaBuffer);
                const publicUrl = await supabaseService.uploadFile(
                    'artifacts',
                    `${Date.now()}.jpg`,
                    supabaseBuffer,
                    'image/jpeg'
                );
                if (publicUrl) messageData.mediaUrl = publicUrl;
            } catch (e) {
                console.warn('⚠️ Could not download image:', e.message);
            }
        } else if (msg.type === 'document') {
            messageData.format = 'pdf';
            messageData.messageDetails = msg.document?.filename || '[Document]';
        } else if (msg.type === 'audio') {
            messageData.format = 'audio';
            messageData.messageDetails = '[Audio message]';
        } else if (msg.type === 'video') {
            messageData.format = 'video';
            messageData.messageDetails = msg.video?.caption || '[Video]';
        } else if (msg.type === 'location') {
            messageData.format = 'location';
            messageData.messageDetails = `Location: ${msg.location?.latitude}, ${msg.location?.longitude}`;
        } else if (msg.type === 'interactive') {
            messageData.format = 'interactive';
            messageData.messageDetails = msg.interactive?.button_reply?.title || '[Interactive message]';
        }

        // Determine group ID
        let groupId = `GID${senderId}`;
        messageData.groupId = groupId;

        // AI-based screening if configured
        if (config.GEMINI_API_KEY && messageData.messageDetails) {
            try {
                const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
                const promptParts = [{ text: screeningPrompt(messageData.messageDetails) }];

                // Add image if available
                if (messageData.buffer) {
                    promptParts.push({
                        inlineData: {
                            data: messageData.buffer.toString('base64'),
                            mimeType: messageData.mimeType
                        }
                    });
                }

                const screenResult = await client.models.generateContent({
                    model: 'gemini-1.5-flash',
                    contents: [{ role: 'user', parts: promptParts }]
                });

                const screenData = JSON.parse(screenResult.text.replace(/```json|```/g, '').trim());
                messageData.messageType = screenData.category || 'other';
                messageData.messageDetails = screenData.extractedDetails || messageData.messageDetails;
            } catch (e) {
                console.warn('⚠️ AI screening failed:', e.message);
                messageData.messageType = 'other';
            }
        }

        // Store message in database
        try {
            await supabaseService.sendtoDatabase(messageData);
        } catch (e) {
            console.error('❌ Failed to store message in database:', e.message);
        }

        // Process for knowledge graph
        try {
            await intelligenceService.processMessageForGraph(
                messageData.messageDetails,
                { messageId, sender: messageData.sender }
            );
        } catch (e) {
            console.warn('⚠️ Graph processing failed:', e.message);
        }
    }

    /**
     * Handle critical commands (e.g., !connect gmail, !enable email)
     */
    async handleCriticalCommands(text, senderId, phoneNumberId) {
        const CriticalCommands = {
            CONNECT_GMAIL: '!connect gmail',
            GMAIL_CODE: '!gmail code',
            ENABLE: '!enable',
            DISABLE: '!disable'
        };

        const commandKey = Object.keys(CriticalCommands).find(key =>
            text.trim().toLowerCase().startsWith(CriticalCommands[key])
        );

        if (!commandKey) return;

        const service = this.getService('default');
        if (!service) return;

        try {
            // Import handler functions
            const { handleConnectGmail, handleGmailCode } = require('./criticalCmds/gmailAuthCmds');

            if (commandKey === 'CONNECT_GMAIL') {
                // Create a mock socket object for compatibility
                const mockSocket = {
                    sendMessage: (jid, msg) => {
                        return service.sendTextMessage(senderId, msg.text);
                    }
                };
                await handleConnectGmail(mockSocket, senderId);
            } else if (commandKey === 'GMAIL_CODE') {
                const mockSocket = {
                    sendMessage: (jid, msg) => {
                        return service.sendTextMessage(senderId, msg.text);
                    }
                };
                // Parse the code from the message
                const code = text.split(' ').slice(2).join(' ');
                await handleGmailCode(mockSocket, senderId, { message: { text } }, code);
            } else if (commandKey === 'ENABLE' || commandKey === 'DISABLE') {
                const isEnable = commandKey === 'ENABLE';
                const provider = text.split(' ')[1]?.toLowerCase();

                if (provider) {
                    const employeeIdDb = await supabaseService.getEmployeeId(senderId);
                    if (!employeeIdDb) throw new Error('Number not registered.');

                    const success = await supabaseService.toggleIntegration(employeeIdDb, provider, isEnable);
                    if (success) {
                        const statusEmoji = isEnable ? '✅' : '🛑';
                        const message = `${statusEmoji} *INTEGRATION ${isEnable ? 'ENABLED' : 'DISABLED'}* ${statusEmoji}\n\n${provider.toUpperCase()} tracking is now ${isEnable ? 'active' : 'paused'} for your account.`;
                        await service.sendTextMessage(senderId, message);
                    }
                }
            }
        } catch (e) {
            console.error('❌ Critical command handler error:', e.message);
            try {
                const service = this.getService('default');
                if (service) {
                    await service.sendTextMessage(senderId, `❌ Error: ${e.message}`);
                }
            } catch (err) {
                console.warn('⚠️ Could not send error message');
            }
        }
    }

    /**
     * Handle template status updates
     */
    async handleTemplateStatusUpdate(data) {
        console.log('📋 Template status update:', data);
        // Handle template status changes (approved, rejected, etc.)
    }

    /**
     * Handle template quality updates
     */
    async handleTemplateQualityUpdate(data) {
        console.log('📊 Template quality update:', data);
        // Handle template quality score changes
    }
}

module.exports = new WebhookHandler();
