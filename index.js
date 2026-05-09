/**
 * Multi-tenant Baileys WhatsApp feeder.
 *
 * Runs in-process inside wa-field-tracker — no separate HTTP listener.
 * The main server imports `sessionManager` directly and invokes its
 * methods, so QR / status / track / disconnect calls are zero-overhead.
 */
const sessionManager         = require('./sessionManager');
const { setWhatsAppHandler } = require('./messageHandler');

async function run() {
    console.log('📬 WhatsApp Baileys feeder: restoring persisted sessions…');
    await sessionManager.initAllSessions();
}

if (require.main === module) {
    run().catch(err => { console.error('Boot failed:', err); process.exit(1); });
}

module.exports = { run, sessionManager, setWhatsAppHandler };
