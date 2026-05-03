const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const config = require('./config');
const supabaseService = require('./supabaseService');
const WhatsAppCloudService = require('./whatsappCloudService');
const webhookHandler = require('./webhookHandler');
const { generateAndSendReport } = require('./generateReport');

/**
 * WhatsApp Cloud API Processor
 * Replaces Baileys-based processor with WhatsApp Cloud API
 */

const app = express();
app.use(express.json());

// Store raw body for signature verification
app.use((req, res, next) => {
    req.rawBody = JSON.stringify(req.body);
    next();
});

let cronJobsStarted = false;
const whatsappServices = {}; // Map of employeeId -> WhatsAppCloudService

/**
 * Initialize WhatsApp service for an employee
 */
async function initializeWhatsAppService(employeeId = 'default', accessToken = null, phoneNumberId = null, businessAccountId = null) {
    try {
        // Use provided tokens or fall back to config
        const token = accessToken || config.WHATSAPP_ACCESS_TOKEN;
        const phoneId = phoneNumberId || config.WHATSAPP_PHONE_NUMBER_ID;
        const businessId = businessAccountId || config.WHATSAPP_BUSINESS_ACCOUNT_ID;

        if (!token || !phoneId) {
            throw new Error('Missing WhatsApp credentials (token or phoneNumberId)');
        }

        const service = new WhatsAppCloudService(employeeId, token, phoneId, businessId);
        whatsappServices[employeeId] = service;
        webhookHandler.registerService(employeeId, service);

        console.log(`✅ WhatsApp Cloud API initialized for employee: ${employeeId}`);
        return service;
    } catch (err) {
        console.error(`❌ Failed to initialize WhatsApp service for ${employeeId}:`, err.message);
        throw err;
    }
}

/**
 * Webhook POST endpoint - receives messages and events
 */
app.post('/webhook', (req, res) => {
    webhookHandler.handleWebhookPost(req, res);
});

/**
 * Webhook GET endpoint - for verification during setup
 */
app.get('/webhook', (req, res) => {
    webhookHandler.handleVerification(req, res);
});

/**
 * REST API endpoints for session/status management
 */

// Get all active services/sessions
app.get('/api/sessions', (req, res) => {
    const sessionList = Object.keys(whatsappServices).map(id => ({
        id,
        type: 'cloud-api',
        connected: true // Cloud API is always "connected" if initialized
    }));
    res.json(sessionList);
});

// Start a new session (with custom credentials)
app.post('/api/sessions/start', async (req, res) => {
    const { employeeId, accessToken, phoneNumberId, businessAccountId } = req.body;

    if (!employeeId) {
        return res.status(400).json({ error: 'employeeId required' });
    }

    try {
        await initializeWhatsAppService(employeeId, accessToken, phoneNumberId, businessAccountId);
        res.json({ message: `WhatsApp Cloud API session initialized for ${employeeId}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get session status
app.get('/api/sessions/status/:employeeId', (req, res) => {
    const { employeeId } = req.params;
    const service = whatsappServices[employeeId];

    if (!service) {
        return res.status(404).json({ error: 'Session not found', connected: false });
    }

    res.json({ 
        connected: true, 
        type: 'cloud-api',
        phoneNumberId: service.phoneNumberId 
    });
});

// Send a test message (for debugging)
app.post('/api/test/send-message', async (req, res) => {
    const { employeeId = 'default', recipientPhone, message } = req.body;

    if (!recipientPhone || !message) {
        return res.status(400).json({ error: 'recipientPhone and message required' });
    }

    try {
        const service = whatsappServices[employeeId];
        if (!service) {
            return res.status(404).json({ error: 'Service not found for employee' });
        }

        const result = await service.sendTextMessage(recipientPhone, message);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Send message through WhatsApp service
 * This is used by other modules (e.g., report generation)
 */
function createMessageSender(employeeId = 'default') {
    return {
        sendMessage: async (recipientPhone, messageObj) => {
            try {
                const service = whatsappServices[employeeId];
                if (!service) {
                    console.warn(`⚠️ Service not found for ${employeeId}`);
                    return { success: false };
                }

                // Handle different message formats
                if (messageObj.text) {
                    return await service.sendTextMessage(recipientPhone, messageObj.text);
                } else if (messageObj.image) {
                    return await service.sendMediaMessage(recipientPhone, messageObj.image.link, 'image', messageObj.image.caption);
                } else if (messageObj.document) {
                    return await service.sendMediaMessage(recipientPhone, messageObj.document.link, 'document', messageObj.document.caption);
                } else if (messageObj.location) {
                    return await service.sendLocationMessage(recipientPhone, messageObj.location.latitude, messageObj.location.longitude, messageObj.location.name);
                }

                return { success: false };
            } catch (err) {
                console.error('❌ Error sending message:', err.message);
                return { success: false, error: err.message };
            }
        }
    };
}

/**
 * Start cron jobs for scheduled tasks
 */
function startCronJobs() {
    if (cronJobsStarted) return;
    cronJobsStarted = true;

    // Daily report at 21:41 IST
    cron.schedule('41 21 * * *', async () => {
        console.log('⏰ Sending daily report...');
        try {
            const messageSender = createMessageSender('default');
            await generateAndSendReport(messageSender);
        } catch (err) {
            console.error('❌ Report generation failed:', err.message);
        }
    }, { scheduled: true, timezone: 'Asia/Kolkata' });

    // Daily knowledge graph update at 23:30 IST
    cron.schedule('30 23 * * *', async () => {
        console.log('⏰ Starting Daily Knowledge Graph Batch Update...');
        try {
            const intelligenceService = require('./intelligenceService');
            await intelligenceService.runDailyGraphUpdate();
        } catch (err) {
            console.error('❌ Graph update failed:', err.message);
        }
    }, { scheduled: true, timezone: 'Asia/Kolkata' });

    console.log('⏰ Cron jobs initialized');
}

/**
 * Initialize all existing sessions from employee database
 * For Cloud API, this just validates that credentials are properly configured
 */
async function initAllSessions() {
    console.log('🚀 Initializing WhatsApp Cloud API Processor...');

    try {
        // Initialize default service with config credentials
        if (config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID) {
            await initializeWhatsAppService('default');
        } else {
            console.warn('⚠️ Default WhatsApp credentials not configured. Using manual session creation.');
        }

        // Retrieve employee-specific credentials from Supabase (if storing per-employee tokens)
        try {
            const employees = await supabaseService.getAllEmployees();
            for (const emp of employees) {
                // Check if employee has WhatsApp credentials stored
                const whatsappCreds = emp.whatsapp_credentials; // Adjust based on your schema
                if (whatsappCreds?.access_token && whatsappCreds?.phone_number_id) {
                    await initializeWhatsAppService(
                        emp.id,
                        whatsappCreds.access_token,
                        whatsappCreds.phone_number_id,
                        whatsappCreds.business_account_id
                    );
                }
            }
        } catch (err) {
            console.warn('⚠️ Could not load employee-specific credentials:', err.message);
        }

        // Start scheduled tasks
        startCronJobs();

        console.log('✅ WhatsApp Cloud API Processor initialized successfully');
    } catch (err) {
        console.error('❌ Processor initialization failed:', err.message);
        throw err;
    }
}

/**
 * Start the processor
 */
function run() {
    console.log('📱 Starting OMNI-BRAIN: WhatsApp Cloud API Container...');
    initAllSessions().catch(err => {
        console.error('❌ WhatsApp Container Crash:', err.message);
        process.exit(1);
    });
}

if (require.main === module) {
    run();
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('⚠️ SIGTERM received. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('⚠️ SIGINT received. Shutting down gracefully...');
    process.exit(0);
});

module.exports = {
    app,
    initAllSessions,
    initializeWhatsAppService,
    createMessageSender,
    run
};
