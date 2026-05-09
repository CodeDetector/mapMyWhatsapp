/**
 * Multi-tenant Baileys session manager.
 * Holds one socket per employee in memory and routes their inbound messages
 * to the storage layer. Auth state lives in Supabase, so processes are
 * stateless and can be restarted without losing pairings.
 */
const {
    makeWASocket,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const { useSupabaseAuthState } = require('./authState');
const waAuthRepo               = require('./waAuthRepo');
const { handleMessage }        = require('./messageHandler');

const SILENT_LOGGER = pino({ level: 'silent' });
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 6;

// employeeId → { sock, qr, connected, jid, retries }
const sessions = new Map();
// employeeId → Set<jid>  (tracked chat cache, refreshed on connect)
const trackedCache = new Map();
// employeeId → Map<jid, { jid, name, notify }>  (contacts seen via contacts.upsert)
const contactsCache = new Map();

function getOrInitEntry(employeeId) {
    if (!sessions.has(employeeId)) {
        sessions.set(employeeId, { sock: null, qr: null, connected: false, jid: null, retries: 0 });
    }
    return sessions.get(employeeId);
}

async function refreshTrackedCache(employeeId) {
    const set = await waAuthRepo.getTrackedJidSet(employeeId);
    trackedCache.set(employeeId, set);
    return set;
}

function upsertContact(employeeId, c) {
    if (!c.id || c.id.endsWith('@g.us') || c.id === 'status@broadcast') return;
    if (!contactsCache.has(employeeId)) contactsCache.set(employeeId, new Map());
    const cache    = contactsCache.get(employeeId);
    const existing = cache.get(c.id) || {};
    const name     = c.name || c.notify || existing.name || existing.notify || c.id.split('@')[0];
    cache.set(c.id, { jid: c.id, name, notify: c.notify || existing.notify || null });
}

async function startSession(employeeId) {
    if (!employeeId) throw new Error('employeeId required');

    const entry = getOrInitEntry(employeeId);
    if (entry.connected) {
        console.log(`ℹ️ WA session ${employeeId} already connected.`);
        return entry;
    }

    console.log(`🔄 Starting WA session for employee ${employeeId}…`);
    const { state, saveCreds } = await useSupabaseAuthState(employeeId);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: SILENT_LOGGER,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        printQRInTerminal: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
    });
    entry.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`💠 QR ready for employee ${employeeId}`);
            entry.qr = qr;
            entry.connected = false;
        }

        if (connection === 'open') {
            entry.connected = true;
            entry.qr        = null;
            entry.retries   = 0;
            entry.jid       = sock.user?.id || null;
            await refreshTrackedCache(employeeId);
            console.log(`✅ WA session ${employeeId} connected as ${entry.jid}`);
        }

        if (connection === 'close') {
            entry.connected = false;
            const code         = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut  = code === DisconnectReason.loggedOut || code === 401 || code === 403;

            if (isLoggedOut) {
                console.warn(`🚫 WA session ${employeeId} logged out (code ${code}). Wiping creds.`);
                await waAuthRepo.wipeAuth(employeeId);
                sessions.delete(employeeId);
                trackedCache.delete(employeeId);
                contactsCache.delete(employeeId);
                return;
            }

            entry.retries += 1;
            if (entry.retries > MAX_RECONNECT_ATTEMPTS) {
                console.error(`⛔ WA session ${employeeId} exceeded ${MAX_RECONNECT_ATTEMPTS} reconnects — giving up.`);
                sessions.delete(employeeId);
                trackedCache.delete(employeeId);
                contactsCache.delete(employeeId);
                return;
            }
            console.log(`🔁 Reconnecting WA session ${employeeId} (attempt ${entry.retries}/${MAX_RECONNECT_ATTEMPTS})…`);
            setTimeout(() => startSession(employeeId).catch(e => console.error(e)), RECONNECT_DELAY_MS);
        }
    });

    sock.ev.on('contacts.upsert',  (contacts) => contacts.forEach(c => upsertContact(employeeId, c)));
    sock.ev.on('contacts.update',  (updates)  => updates.forEach(c => upsertContact(employeeId, c)));

    // Chats list fires on connect — seed contacts from every non-group chat
    sock.ev.on('chats.upsert', (chats) => {
        for (const chat of chats) {
            upsertContact(employeeId, { id: chat.id, name: chat.name || chat.pushName || null });
        }
        console.log(`📒 [emp ${employeeId}] contacts cache now has ${contactsCache.get(employeeId)?.size || 0} entries`);
    });

    sock.ev.on('messages.upsert', async (m) => {
        console.log(`📥 [emp ${employeeId}] messages.upsert type=${m.type}, count=${m.messages?.length || 0}`);
        if (m.type !== 'notify') return;

        // Lazy cache load — handles the case where 'open' fired before the
        // first DB read landed, or the cache was evicted on disconnect.
        let tracked = trackedCache.get(employeeId);
        if (!tracked) {
            console.log(`🔍 [emp ${employeeId}] tracked cache miss — refreshing from DB`);
            tracked = await refreshTrackedCache(employeeId);
        }

        if (!tracked || tracked.size === 0) {
            console.log(`⏭️  [emp ${employeeId}] no tracked chats — dropping ${m.messages.length} message(s)`);
            return;
        }

        for (const msg of m.messages) {
            const remoteJid = msg.key?.remoteJid;
            // Seed contact cache from every individual chat sender we see
            if (remoteJid && !remoteJid.endsWith('@g.us') && remoteJid !== 'status@broadcast') {
                upsertContact(employeeId, { id: remoteJid, name: msg.pushName || null });
            }
            const isTracked = tracked.has(remoteJid);
            console.log(`📨 [emp ${employeeId}] msg from ${remoteJid} → ${isTracked ? 'TRACKED ✓' : 'untracked, skip'}`);
            try {
                await handleMessage(msg, sock, employeeId, tracked);
            } catch (err) {
                console.error(`❌ message handler error (emp ${employeeId}, id ${msg.key?.id}):`, err.message);
            }
        }
    });

    return entry;
}

function getStatus(employeeId) {
    const e = sessions.get(employeeId);
    if (!e) return { connected: false, qr: null, jid: null };
    return { connected: e.connected, qr: e.qr, jid: e.jid };
}

async function disconnect(employeeId) {
    const e = sessions.get(employeeId);
    if (e?.sock) {
        try { await e.sock.logout(); } catch { /* ignore */ }
    }
    sessions.delete(employeeId);
    trackedCache.delete(employeeId);
    contactsCache.delete(employeeId);
    await waAuthRepo.wipeAuth(employeeId);
}

async function listGroups(employeeId) {
    const e = sessions.get(employeeId);
    if (!e?.sock || !e.connected) return [];
    try {
        const groups = await e.sock.groupFetchAllParticipating();
        return Object.values(groups).map(g => ({
            jid:           g.id,
            name:          g.subject,
            participants:  g.participants?.length || 0,
            type:          'group',
        }));
    } catch (err) {
        console.error('listGroups error:', err.message);
        return [];
    }
}

async function trackChat(employeeId, jid, displayName, chatType = 'group') {
    await waAuthRepo.addTrackedChat(employeeId, jid, displayName, chatType);
    await refreshTrackedCache(employeeId);
}

async function untrackChat(employeeId, jid) {
    await waAuthRepo.removeTrackedChat(employeeId, jid);
    await refreshTrackedCache(employeeId);
}

async function listTracked(employeeId) {
    return waAuthRepo.listTrackedChats(employeeId);
}

function listContacts(employeeId) {
    const cache = contactsCache.get(employeeId);
    if (!cache) return [];
    return Array.from(cache.values())
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// Verify a phone number is on WhatsApp and return its JID + display name.
async function resolvePhone(employeeId, phone) {
    const e = sessions.get(employeeId);
    if (!e?.sock || !e.connected) throw new Error('Session not connected');
    // Normalise: strip non-digits, ensure no leading +
    const digits = phone.replace(/\D/g, '');
    const [result] = await e.sock.onWhatsApp(digits);
    if (!result?.exists) return null;
    const cache  = contactsCache.get(employeeId);
    const cached = cache?.get(result.jid);
    const name   = cached?.name || cached?.notify || digits;
    // Persist into cache so it shows up in listContacts
    upsertContact(employeeId, { id: result.jid, name });
    return { jid: result.jid, name };
}

// Restore every persisted session on process boot.
async function initAllSessions() {
    const employeeIds = await waAuthRepo.listEmployeesWithCreds();
    if (employeeIds.length === 0) {
        console.log('🆕 No persisted WA sessions to restore.');
        return;
    }
    console.log(`📂 Restoring ${employeeIds.length} WA session(s)…`);
    for (const id of employeeIds) {
        startSession(id).catch(err => console.error(`Failed to restore session ${id}:`, err.message));
    }
}

module.exports = {
    startSession,
    getStatus,
    disconnect,
    listGroups,
    listContacts,
    resolvePhone,
    trackChat,
    untrackChat,
    listTracked,
    refreshTrackedCache,
    initAllSessions,
};
