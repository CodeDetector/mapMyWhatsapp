/**
 * Inbound message router for the multi-tenant Baileys feeder.
 * - Filters out messages from chats the employee is not tracking.
 * - Downloads media into the `artifacts` bucket.
 * - Builds a canonical parsedMessage and passes it to the registered handler.
 *
 * The handler is injectable via setWhatsAppHandler() so the host process
 * (wa-field-tracker) can route through its two-layer pipeline instead of
 * writing directly to Supabase here.
 */
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino   = require('pino');
const crypto = require('crypto');
const { parseMessage }  = require('./messageParser');
const supabaseService   = require('./supabaseService');
const { enqueue: enqueueAgentJob } = require('./queue');

const SILENT_LOGGER = pino({ level: 'silent' });

// ── Default handler (standalone feeder behaviour) ────────────────────────────
// 1. Persist the message (intake → messages, channel → Whatsapp tables).
// 2. Enqueue an agent_jobs row so the refinement worker (in omni-backend) picks it up.
async function _defaultWAHandler(parsedMessage, ownerEmployeeId) {
    await supabaseService.sendTrackedMessageToDatabase(parsedMessage, ownerEmployeeId);
    await enqueueAgentJob({
        channel: 'whatsapp',
        sourceTable: 'Whatsapp',
        sourceId: null,
        payload: {
            messageTraceId: parsedMessage.messageId || null,
            employeeId:     ownerEmployeeId,
            chatJid:        parsedMessage.chatJid      || null,
            senderName:     parsedMessage.sender       || null,
            senderNumber:   parsedMessage.senderNumber || null,
            senderLabel:    parsedMessage.sender || parsedMessage.senderNumber || null,
            messageText:    parsedMessage.messageDetails || '',
            format:         parsedMessage.format || 'text',
            mediaUrl:       parsedMessage.mediaUrl || null,
        },
    });
}

let _waHandler = _defaultWAHandler;

function setWhatsAppHandler(fn) {
    _waHandler = fn;
}

// ── MIME helpers ─────────────────────────────────────────────────────────────
function pickMediaShape(format) {
    switch (format) {
        case 'photo': return { mime: 'image/jpeg',             ext: 'jpg' };
        case 'video': return { mime: 'video/mp4',              ext: 'mp4' };
        case 'audio': return { mime: 'audio/ogg; codecs=opus', ext: 'ogg' };
        case 'pdf':   return { mime: 'application/pdf',        ext: 'pdf' };
        default:      return null;
    }
}

// ── Core handler ─────────────────────────────────────────────────────────────
async function handleMessage(msg, sock, ownerEmployeeId, trackedJids) {
    const remoteJid = msg.key?.remoteJid;
    if (!msg.message || !remoteJid) return;
    if (remoteJid === 'status@broadcast') return;
    if (!trackedJids || !trackedJids.has(remoteJid)) return;

    const parsed = parseMessage(msg);
    if (!parsed) return;

    const rawSender    = msg.key.participant || remoteJid;
    const senderNumber = rawSender.split('@')[0];
    const sender       = msg.pushName || senderNumber;

    const parsedMessage = {
        // intake (messages table) fields
        messageId:      parsed.messageId,
        format:         parsed.format,
        messageDetails: parsed.messageDetails,
        // WA channel fields
        chatJid:        remoteJid,
        groupId:        remoteJid.endsWith('@g.us') ? `GID${remoteJid.split('@')[0]}` : null,
        sender,
        senderNumber,
        action:         parsed.action,
        timestamp:      new Date().toLocaleString(),
    };

    // Media download → upload to Supabase storage
    const shape = pickMediaShape(parsed.format);
    if (shape) {
        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: SILENT_LOGGER });
            if (buffer && buffer.length > 0) {
                parsedMessage.mediaHash = crypto.createHash('sha256').update(buffer).digest('hex');
                const fileName = `wa_${ownerEmployeeId}_${Date.now()}.${shape.ext}`;
                parsedMessage.mediaUrl  = await supabaseService.uploadFile('artifacts', fileName, buffer, shape.mime) || null;
            }
        } catch (err) {
            console.warn(`⚠️ Media download failed for ${msg.key.id}:`, err.message);
        }
    }

    await _waHandler(parsedMessage, ownerEmployeeId);
}

module.exports = { handleMessage, setWhatsAppHandler };
