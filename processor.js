const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');
const cron = require('node-cron');
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const supabaseService = require('./supabaseService');
const intelligenceService = require('./intelligenceService');
const prompts = require('./prompts');
const { generateAndSendReport } = require('./generateReport');
const { handleConnectGmail, handleGmailCode } = require('./criticalCmds/gmailAuthCmds');

const { parseMessage } = require('./messageParser');
const { screeningPrompt } = prompts;

const CriticalCommands = {
    CONNECT_GMAIL: '!connect gmail',
    GMAIL_CODE: '!gmail code',
    ENABLE: '!enable',
    DISABLE: '!disable'
};

const groupNameCache = {};
let cronJobsStarted = false;
const sessions = {};
const sessionRetryCounts = {}; // Track reconnect attempts per session to avoid infinite QR loops

const app = express();
app.use(express.json());

async function connectToWhatsApp(employeeId = 'default') {
    if (sessions[employeeId] && sessions[employeeId].connected) {
        console.log(`ℹ️ Session ${employeeId} already connected.`);
        return;
    }

    console.log(`🔄 Initializing WhatsApp session for employee: ${employeeId}`);
    const authPath = path.join(__dirname, 'sessions', `session_${employeeId}`);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    });

    sessions[employeeId] = { sock, connected: false, qr: null };

    const reportStatus = async (connected, qr = null) => {
        sessions[employeeId].connected = connected;
        sessions[employeeId].qr = qr;
        try {
            await fetch('http://localhost:3000/api/whatsapp/update-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ employeeId, connected, qr })
            });
        } catch (err) {
            console.error(`⚠️ Could not report status for ${employeeId}:`, err.message);
        }
    };

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`💠 QR Code generated for session: ${employeeId}`);
            reportStatus(false, qr);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ WhatsApp Session ${employeeId} closed. Status: ${statusCode}`);
            reportStatus(false);

            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 405;

            if (isLoggedOut) {
                console.error(`❌ Session ${employeeId} dead. Requires re-auth.`);
                delete sessions[employeeId];
                delete sessionRetryCounts[employeeId];
                // Remove session folder from disk so it won't auto-reload on next restart
                const authPath = path.join(__dirname, 'sessions', `session_${employeeId}`);
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                    console.log(`🗑️  Deleted dead session folder for employee ${employeeId}.`);
                }
            } else {
                // Guard against infinite QR-timeout loops (e.g. status 408)
                sessionRetryCounts[employeeId] = (sessionRetryCounts[employeeId] || 0) + 1;
                const MAX_RETRIES = 6;
                if (sessionRetryCounts[employeeId] > MAX_RETRIES) {
                    console.error(`🚫 Session ${employeeId} exceeded ${MAX_RETRIES} reconnect attempts. Giving up. Scan QR from the dashboard to restart.`);
                    delete sessions[employeeId];
                    delete sessionRetryCounts[employeeId];
                } else {
                    console.log(`🔄 Reconnecting session ${employeeId} in 5 seconds... (attempt ${sessionRetryCounts[employeeId]}/${MAX_RETRIES})`);
                    setTimeout(() => connectToWhatsApp(employeeId), 5000);
                }
            }
        } else if (connection === 'open') {
            const connectedNumber = sock.user.id.split(':')[0];
            console.log(`📡 Connection attempt from: ${connectedNumber}`);

            // Verification Check
            if (employeeId !== 'default') {
                supabaseService.getEmployeeById(employeeId).then(emp => {
                    if (!emp || (emp.Mobile.replace(/\D/g, '') !== connectedNumber && emp.contact?.toString() !== connectedNumber)) {
                        console.error(`❌ Security Violation: WhatsApp number ${connectedNumber} does not match registered mobile for employee ${employeeId}.`);
                        sock.logout();
                    } else {
                        console.log(`✅ WhatsApp Session ${employeeId} (${emp.Name}) is VERIFIED and READY!`);
                        sessionRetryCounts[employeeId] = 0; // Reset retry counter on successful connect
                        reportStatus(true);
                    }
                });
            } else {
                console.log(`✅ WhatsApp Session ${employeeId} is READY (Default/Admin)!`);
                sessionRetryCounts[employeeId] = 0; // Reset retry counter on successful connect
                reportStatus(true);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const messages = m.messages;
        if (m.type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;
            const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            const text = rawText.trim();
            const remoteJid = msg.key.remoteJid;

            const commandKey = Object.keys(CriticalCommands).find(key => text.startsWith(CriticalCommands[key]));

            if (commandKey) {
                const fullCommand = CriticalCommands[commandKey];
                if (fullCommand === CriticalCommands.CONNECT_GMAIL) await handleConnectGmail(sock, remoteJid);
                if (fullCommand === CriticalCommands.GMAIL_CODE) await handleGmailCode(sock, remoteJid, msg, text);
                if (fullCommand === CriticalCommands.ENABLE || fullCommand === CriticalCommands.DISABLE) {
                    const isEnable = fullCommand === CriticalCommands.ENABLE;
                    const provider = text.split(' ')[1]?.toLowerCase();
                    const senderNum = (msg.key.participant || remoteJid).split('@')[0];
                    if (provider) {
                        try {
                            const employeeIdDb = await supabaseService.getEmployeeId(senderNum);
                            if (!employeeIdDb) throw new Error("Number not registered.");
                            const success = await supabaseService.toggleIntegration(employeeIdDb, provider, isEnable);
                            if (success) {
                                const statusEmoji = isEnable ? '✅' : '🛑';
                                await sock.sendMessage(remoteJid, { text: `${statusEmoji} *INTEGRATION ${isEnable ? 'ENABLED' : 'DISABLED'}* ${statusEmoji}\n\n${provider.toUpperCase()} tracking is now ${isEnable ? 'active' : 'paused'} for your account.` });
                            }
                        } catch (err) {
                            await sock.sendMessage(remoteJid, { text: `❌ error: ${err.message}` });
                        }
                    }
                }
                continue;
            }

            if (!msg.key || remoteJid === 'status@broadcast') continue;
            if (!remoteJid.endsWith('@g.us') && !config.ALLOW_PRIVATE_CHATS) continue;

            let groupName = remoteJid;
            try {
                if (!groupNameCache[remoteJid]) {
                    const groupMeta = await sock.groupMetadata(remoteJid);
                    groupName = groupMeta.subject || remoteJid;
                    groupNameCache[remoteJid] = groupName;
                } else {
                    groupName = groupNameCache[remoteJid];
                }
            } catch (e) { }

            if (config.ALLOWED_GROUP_NAMES?.length > 0) {
                if (!config.ALLOWED_GROUP_NAMES.includes(groupName.toLowerCase().trim())) continue;
            }

            const rawSender = msg.key.participant || remoteJid;
            const sender = msg.pushName || rawSender.split('@')[0] || rawSender;
            const groupId = "GID" + remoteJid.split('@')[0];

            const parsedData = parseMessage(msg);
            if (!parsedData) continue;

            const message = {
                ...parsedData,
                groupId: groupId,
                sender: sender,
                senderNumber: (msg.key.participant || remoteJid).split('@')[0],
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
                    const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
                    const promptParts = [{ text: screeningPrompt(message.messageDetails || "") }];
                    if (message.buffer) promptParts.push({ inlineData: { data: message.buffer.toString('base64'), mimeType: message.mimeType } });

                    const screenResult = await client.models.generateContent({
                        model: 'gemini-1.5-flash',
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

    if (!cronJobsStarted) {
        startCronJobs(sock);
        cronJobsStarted = true;
    }
}

function startCronJobs(sock) {
    cron.schedule('41 21 * * *', async () => {
        console.log('⏰ Sending daily report...');
        await generateAndSendReport(sock);
    }, { scheduled: true, timezone: "Asia/Kolkata" });

    cron.schedule('30 23 * * *', async () => {
        console.log('⏰ Starting Daily Knowledge Graph Batch Update...');
        await intelligenceService.runDailyGraphUpdate();
    }, { scheduled: true, timezone: "Asia/Kolkata" });
}

// REST API for session control
app.get('/api/sessions', (req, res) => {
    const sessionList = Object.keys(sessions).map(id => ({
        id,
        connected: sessions[id].connected,
        hasQr: !!sessions[id].qr
    }));
    res.json(sessionList);
});

app.post('/api/sessions/start', async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    
    connectToWhatsApp(employeeId).catch(err => console.error(err));
    res.json({ message: `Session start initiated for ${employeeId}` });
});

app.get('/api/sessions/status/:employeeId', (req, res) => {
    const { employeeId } = req.params;
    const session = sessions[employeeId];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ connected: session.connected, qr: session.qr });
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`📡 WhatsApp Manager API listening on port ${PORT}`);
});

// Auto-reconnect all existing sessions on startup
const initAllSessions = async () => {
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

    const files = fs.readdirSync(sessionsDir);
    const existingSessions = files.filter(f => f.startsWith('session_')).map(f => f.replace('session_', ''));
    
    // Migrate legacy auth_info_baileys → sessions/session_default (only if it has valid creds)
    const legacyAuthPath = path.join(__dirname, 'auth_info_baileys');
    const legacyCredsFile = path.join(legacyAuthPath, 'creds.json');
    if (fs.existsSync(legacyCredsFile)) {
        const target = path.join(sessionsDir, 'session_default');
        if (!fs.existsSync(target)) {
            console.log('🚚 Migrating legacy session to sessions/session_default');
            fs.renameSync(legacyAuthPath, target);
            if (!existingSessions.includes('default')) existingSessions.push('default');
        } else {
            console.log('⚠️  Legacy auth_info_baileys found but session_default already exists. Skipping migration.');
        }
    } else if (fs.existsSync(legacyAuthPath)) {
        // Stale/empty auth_info_baileys with no creds — delete it
        console.log('🗑️  Removing stale auth_info_baileys (no creds.json found).');
        fs.rmSync(legacyAuthPath, { recursive: true, force: true });
    }

    if (existingSessions.length === 0) {
        console.log('🆕 No existing sessions found. Starting default session.');
        connectToWhatsApp('default');
    } else {
        console.log(`📂 Found ${existingSessions.length} existing sessions. Reconnecting...`);
        for (const empId of existingSessions) {
            await connectToWhatsApp(empId);
        }
    }
};

module.exports = { connectToWhatsApp, initAllSessions };
