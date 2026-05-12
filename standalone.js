/**
 * Standalone HTTP server for the omni-whatsapp container.
 *
 * Runs the Baileys multi-tenant feeder and exposes its sessionManager via
 * HTTP so omni-backend can manage WA sessions over the omni-network bridge
 * (no in-process coupling).
 *
 * Auth: all /sessions/* routes require X-Internal-Service-Token. omni-business
 * uses the same pattern. The container has no published port — it's only
 * reachable from sibling containers on the docker network.
 */

const express = require('express');
const sessionManager = require('./sessionManager');

const PORT = process.env.PORT || 3001;
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';

function requireInternalToken(req, res, next) {
    if (!INTERNAL_TOKEN) {
        return res.status(500).json({ error: 'INTERNAL_SERVICE_TOKEN not configured' });
    }
    if (req.headers['x-internal-service-token'] !== INTERNAL_TOKEN) {
        return res.status(401).json({ error: 'Invalid internal token' });
    }
    next();
}

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => res.json({ ok: true, service: 'mapMyWhatsapp' }));

// ─── Session management ─────────────────────────────────────────────────────
// Mirrors sessionManager's surface. Number(employeeId) on every path because
// the route param is a string and the manager keys by numeric ID.

app.post('/sessions/:employeeId/start', requireInternalToken, (req, res) => {
    const empId = Number(req.params.employeeId);
    if (!empId) return res.status(400).json({ error: 'employeeId required' });
    // Fire-and-forget: connection runs async, status is polled via GET /status.
    sessionManager.startSession(empId).catch(err =>
        console.error(`startSession ${empId}:`, err.message)
    );
    res.json({ ok: true });
});

app.get('/sessions/:employeeId/status', requireInternalToken, (req, res) => {
    const empId = Number(req.params.employeeId);
    if (!empId) return res.status(400).json({ error: 'employeeId required' });
    res.json(sessionManager.getStatus(empId));
});

app.post('/sessions/:employeeId/disconnect', requireInternalToken, async (req, res) => {
    const empId = Number(req.params.employeeId);
    if (!empId) return res.status(400).json({ error: 'employeeId required' });
    try {
        await sessionManager.disconnect(empId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/sessions/:employeeId/groups', requireInternalToken, async (req, res) => {
    const empId = Number(req.params.employeeId);
    if (!empId) return res.status(400).json({ error: 'employeeId required' });
    try {
        res.json(await sessionManager.listGroups(empId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/sessions/:employeeId/contacts', requireInternalToken, (req, res) => {
    const empId = Number(req.params.employeeId);
    if (!empId) return res.status(400).json({ error: 'employeeId required' });
    res.json(sessionManager.listContacts(empId));
});

app.post('/sessions/:employeeId/contacts/resolve', requireInternalToken, async (req, res) => {
    const empId = Number(req.params.employeeId);
    const { phone } = req.body || {};
    if (!empId || !phone) return res.status(400).json({ error: 'employeeId and phone required' });
    try {
        res.json(await sessionManager.resolvePhone(empId, phone));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/sessions/:employeeId/tracked', requireInternalToken, async (req, res) => {
    const empId = Number(req.params.employeeId);
    if (!empId) return res.status(400).json({ error: 'employeeId required' });
    try {
        res.json(await sessionManager.listTracked(empId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/sessions/:employeeId/track', requireInternalToken, async (req, res) => {
    const empId = Number(req.params.employeeId);
    const { jid, displayName, chatType = 'group' } = req.body || {};
    if (!empId || !jid) return res.status(400).json({ error: 'employeeId and jid required' });
    try {
        await sessionManager.trackChat(empId, jid, displayName, chatType);
        const tracked = await sessionManager.listTracked(empId);
        res.json({ ok: true, trackedCount: tracked.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/sessions/:employeeId/track', requireInternalToken, async (req, res) => {
    const empId = Number(req.params.employeeId);
    const { jid } = req.body || {};
    if (!empId || !jid) return res.status(400).json({ error: 'employeeId and jid required' });
    try {
        await sessionManager.untrackChat(empId, jid);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
    console.log('📬 WhatsApp Baileys feeder: restoring persisted sessions…');
    try {
        await sessionManager.initAllSessions();
    } catch (err) {
        console.error('initAllSessions failed:', err.message);
    }
    app.listen(PORT, () => {
        console.log(`mapMyWhatsapp listening on :${PORT}`);
    });
}

boot().catch(err => {
    console.error('mapMyWhatsapp boot failed:', err);
    process.exit(1);
});
