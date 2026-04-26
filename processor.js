const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');
const cron = require('node-cron');
const config = require('./config');
const supabaseService = require('./supabaseService');
const intelligenceService = require('./intelligenceService');
const prompts = require('./prompts');
const { generateAndSendReport } = require('./generateReport');
const { handleConnectGmail, handleGmailCode } = require('./criticalCmds/gmailAuthCmds');

const { parseMessage } = require('./messageParser');
const { screeningPrompt, leaveExtractionPrompt, paymentExtractionPrompt, visitExtractionPrompt } = prompts;

const CriticalCommands = {
    CONNECT_GMAIL: '!connect gmail',
    GMAIL_CODE: '!gmail code',
    ENABLE: '!enable',
    DISABLE: '!disable'
};

const groupNameCache = {};
let cronJobsStarted = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    });

    const reportStatus = async (connected, qr = null) => {
        try {
            await fetch('http://localhost:3000/api/whatsapp/update-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connected, qr })
            });
        } catch (err) {
            console.error('⚠️ Could not report status to backend:', err.message);
        }
    };

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            reportStatus(false, qr);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ WhatsApp Connection closed. Status: ${statusCode}`);
            reportStatus(false);

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 405;

            if (shouldReconnect) {
                console.log('🔄 Reconnecting WhatsApp in 5 seconds...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.error('❌ WhatsApp Session dead. Please delete auth_info_baileys and restart.');
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot is ready and connected!');
            reportStatus(true);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const messages = m.messages;
        if (m.type !== 'notify') return;

        for (const msg of messages) {
            const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            const text = rawText.trim();
            const remoteJid = msg.key.remoteJid;

            const commandKey = Object.keys(CriticalCommands).find(key => text.startsWith(CriticalCommands[key]));

            if (commandKey) {
                console.log(`🤖 Command detected: ${text} (${commandKey})`);

                const fullCommand = CriticalCommands[commandKey];

                if (fullCommand === CriticalCommands.CONNECT_GMAIL) {
                    await handleConnectGmail(sock, remoteJid);
                }

                if (fullCommand === CriticalCommands.GMAIL_CODE) {
                    await handleGmailCode(sock, remoteJid, msg, text);
                }

                if (fullCommand === CriticalCommands.ENABLE || fullCommand === CriticalCommands.DISABLE) {
                    const isEnable = fullCommand === CriticalCommands.ENABLE;
                    const provider = text.split(' ')[1]?.toLowerCase();
                    const senderNum = (msg.key.participant || remoteJid).split('@')[0];

                    if (provider) {
                        try {
                            const employeeId = await supabaseService.getEmployeeId(senderNum);
                            if (!employeeId) throw new Error("Number not registered.");

                            const success = await supabaseService.toggleIntegration(employeeId, provider, isEnable);
                            if (success) {
                                const statusEmoji = isEnable ? '✅' : '🛑';
                                const statusText = isEnable ? 'ENABLED' : 'DISABLED';
                                await sock.sendMessage(remoteJid, { text: `${statusEmoji} *INTEGRATION ${statusText}* ${statusEmoji}\n\n${provider.toUpperCase()} tracking is now ${statusText.toLowerCase()} for your account.` });
                            } else {
                                throw new Error("Failed to update status.");
                            }
                        } catch (err) {
                            await sock.sendMessage(remoteJid, { text: `❌ error: ${err.message}` });
                        }
                    }
                }

                // Skip further processing (DB logging, AI analysis) for all commands
                continue;
            }

            if (!msg.key || remoteJid === 'status@broadcast') continue;
            // From this point on, we only log ACTUAL business messages
            if (!remoteJid.endsWith('@g.us') && !config.ALLOW_PRIVATE_CHATS) continue;


            let groupName = msg.key.remoteJid;
            try {
                if (!groupNameCache[msg.key.remoteJid]) {
                    const groupMeta = await sock.groupMetadata(msg.key.remoteJid);
                    groupName = groupMeta.subject || msg.key.remoteJid;
                    groupNameCache[msg.key.remoteJid] = groupName;
                } else {
                    groupName = groupNameCache[msg.key.remoteJid];
                }
            } catch (e) { }

            if (config.ALLOWED_GROUP_NAMES?.length > 0) {
                if (!config.ALLOWED_GROUP_NAMES.includes(groupName.toLowerCase().trim())) continue;
            }

            const rawSender = msg.key.participant || msg.key.remoteJid;
            const sender = msg.pushName || rawSender.split('@')[0] || rawSender;
            const groupId = "GID" + msg.key.remoteJid.split('@')[0];

            const parsedData = parseMessage(msg);
            if (!parsedData) continue;

            const message = {
                ...parsedData,
                groupId: groupId,
                sender: sender,
                senderNumber: msg.key.participant.split('@')[0],
                timestamp: new Date().toLocaleString()
            };

            if (parsedData.format === 'photo') {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    message.buffer = buffer;
                    message.mimeType = 'image/jpeg';
                    message.mediaHash = crypto.createHash('sha256').update(buffer).digest('hex');
                    const publicUrl = await supabaseService.uploadFile('artifacts', `${Date.now()}.jpg`, buffer, 'image/jpeg');
                    if (publicUrl) message.mediaUrl = publicUrl;
                } catch (e) { }
            }

            let category = 'other';
            if (config.GEMINI_API_KEY && (message.messageDetails || message.buffer)) {
                try {
                    console.log(`🔍 Analyzing message from ${message.sender}...`);
                    const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
                    const promptParts = [{ text: screeningPrompt(message.messageDetails || "") }];
                    if (message.buffer) promptParts.push({ inlineData: { data: message.buffer.toString('base64'), mimeType: message.mimeType } });

                    const screenResult = await client.models.generateContent({
                        model: 'gemma-4-31b-it',
                        contents: [{ role: 'user', parts: promptParts }]
                    });

                    const screenData = JSON.parse(screenResult.text.replace(/```json|```/g, '').trim());
                    category = screenData.category || 'other';
                    message.messageDetails = screenData.extractedDetails || message.messageDetails;
                } catch (e) { }
            }

            message.messageType = category;
            await supabaseService.sendtoDatabase(message);

            await intelligenceService.processMessageForGraph(
                message.messageDetails,
                { messageId: message.messageId, sender: message.sender }
            );
        }
    });



    // 📊 Daily Reports
    if (!cronJobsStarted) {
        cron.schedule('41 21 * * *', async () => {
            console.log('⏰ Sending daily report...');
            await generateAndSendReport(sock);
        }, { scheduled: true, timezone: "Asia/Kolkata" });

        // 🕸️ Daily Knowledge Graph Batch Update
        cron.schedule('30 23 * * *', async () => {
            console.log('⏰ Starting Daily Knowledge Graph Batch Update...');
            await intelligenceService.runDailyGraphUpdate();
        }, { scheduled: true, timezone: "Asia/Kolkata" });
        cronJobsStarted = true;

    }
}

module.exports = { connectToWhatsApp };
