/**
 * Repository for the WhatsApp auth state tables and tracked-chat list.
 * Reuses the singleton Supabase client from supabaseService.
 */
const supabaseService = require('./supabaseService');

function client() {
    if (!supabaseService.client) throw new Error('Supabase client not initialised');
    return supabaseService.client;
}

// ─── creds ────────────────────────────────────────────────────────────────────

async function loadCreds(employeeId) {
    const { data, error } = await client()
        .from('wa_auth_creds')
        .select('creds')
        .eq('employee_id', employeeId)
        .maybeSingle();
    if (error) { console.error('loadCreds error:', error.message); return null; }
    return data?.creds || null;
}

async function saveCreds(employeeId, credsJson) {
    const { error } = await client()
        .from('wa_auth_creds')
        .upsert(
            { employee_id: employeeId, creds: credsJson, updated_at: new Date().toISOString() },
            { onConflict: 'employee_id' }
        );
    if (error) console.error('saveCreds error:', error.message);
}

// ─── signal keys ──────────────────────────────────────────────────────────────

async function loadKey(employeeId, type, keyId) {
    const { data, error } = await client()
        .from('wa_auth_keys')
        .select('data')
        .eq('employee_id', employeeId)
        .eq('type', type)
        .eq('key_id', keyId)
        .maybeSingle();
    if (error) { console.error('loadKey error:', error.message); return null; }
    return data?.data || null;
}

async function saveKey(employeeId, type, keyId, dataJson) {
    const { error } = await client()
        .from('wa_auth_keys')
        .upsert(
            { employee_id: employeeId, type, key_id: keyId, data: dataJson, updated_at: new Date().toISOString() },
            { onConflict: 'employee_id,type,key_id' }
        );
    if (error) console.error('saveKey error:', error.message);
}

async function deleteKey(employeeId, type, keyId) {
    await client()
        .from('wa_auth_keys')
        .delete()
        .eq('employee_id', employeeId)
        .eq('type', type)
        .eq('key_id', keyId);
}

// Wipe everything on logout / orphan cleanup. Also clears tracked chats so
// the next pairing starts from a clean slate.
async function wipeAuth(employeeId) {
    await client().from('wa_auth_keys').delete().eq('employee_id', employeeId);
    await client().from('wa_auth_creds').delete().eq('employee_id', employeeId);
    await client().from('wa_tracked_chats').delete().eq('employee_id', employeeId);
}

// All employees who have a stored session — used to auto-restore on startup.
async function listEmployeesWithCreds() {
    const { data, error } = await client()
        .from('wa_auth_creds')
        .select('employee_id');
    if (error) { console.error('listEmployeesWithCreds error:', error.message); return []; }
    return (data || []).map(r => r.employee_id);
}

// ─── tracked chats ────────────────────────────────────────────────────────────

async function listTrackedChats(employeeId) {
    const { data, error } = await client()
        .from('wa_tracked_chats')
        .select('id, jid, display_name, chat_type')
        .eq('employee_id', employeeId)
        .order('display_name');
    if (error) { console.error('listTrackedChats error:', error.message); return []; }
    return data || [];
}

async function getTrackedJidSet(employeeId) {
    const tracked = await listTrackedChats(employeeId);
    return new Set(tracked.map(t => t.jid));
}

async function addTrackedChat(employeeId, jid, displayName, chatType) {
    console.log(`📌 addTrackedChat: emp=${employeeId} jid=${jid} name="${displayName}" type=${chatType}`);
    const { data, error } = await client()
        .from('wa_tracked_chats')
        .upsert(
            { employee_id: employeeId, jid, display_name: displayName, chat_type: chatType },
            { onConflict: 'employee_id,jid' }
        )
        .select();
    if (error) {
        console.error('❌ addTrackedChat error:', error.message);
        throw error;
    }
    console.log(`✅ addTrackedChat saved: ${data?.[0]?.id}`);
}

async function removeTrackedChat(employeeId, jid) {
    await client()
        .from('wa_tracked_chats')
        .delete()
        .eq('employee_id', employeeId)
        .eq('jid', jid);
}

// Try to auto-resolve a participant against the contacts table by phone/JID/LID.
// Returns the contact id if matched, else null.
async function matchContactForParticipant({ jid, lid }) {
    const sb = client();
    const phone = jid && !jid.endsWith('@lid') ? jid.split('@')[0] : null;
    if (phone) {
        const { data } = await sb.from('contacts').select('id').eq('phone', phone).maybeSingle();
        if (data) return data.id;
    }
    if (jid) {
        const { data } = await sb.from('contacts').select('id').eq('wa_jid', jid).maybeSingle();
        if (data) return data.id;
    }
    if (lid) {
        const { data } = await sb.from('contacts').select('id').eq('wa_lid', lid).maybeSingle();
        if (data) return data.id;
    }
    return null;
}

// Backfill helper: insert rows for participants who just joined a tracked group.
// Each new participant is auto-resolved if we have a matching contact, else
// stored as unresolved (which will gate message tracking).
async function addParticipantsToGroup(employeeId, groupJid, participants) {
    const sb = client();
    const rows = [];
    for (const p of participants) {
        const lid = p.lid || (p.jid?.endsWith('@lid') ? p.jid : null);
        const contactId = await matchContactForParticipant({ jid: p.jid, lid });
        rows.push({
            employee_id:     employeeId,
            group_jid:       groupJid,
            participant_jid: p.jid,
            participant_lid: lid,
            notify_name:     p.notify || null,
            contact_id:      contactId,
            resolved:        Boolean(contactId),
        });
    }
    if (!rows.length) return;
    const { error } = await sb
        .from('wa_group_participants')
        .upsert(rows, { onConflict: 'employee_id,group_jid,participant_jid' });
    if (error) console.error('addParticipantsToGroup error:', error.message);
}

// Remove participants who left a group (so they no longer block readiness).
async function removeParticipantsFromGroup(employeeId, groupJid, participantJids) {
    if (!participantJids.length) return;
    const { error } = await client()
        .from('wa_group_participants')
        .delete()
        .eq('employee_id', employeeId)
        .eq('group_jid',   groupJid)
        .in('participant_jid', participantJids);
    if (error) console.error('removeParticipantsFromGroup error:', error.message);
}

// Returns the set of group JIDs (for an employee) where every participant has
// been resolved. Group messages outside this set are dropped by the handler.
async function getReadyGroupSet(employeeId) {
    const { data, error } = await client()
        .from('wa_group_participants')
        .select('group_jid, resolved')
        .eq('employee_id', employeeId);
    if (error) { console.error('getReadyGroupSet error:', error.message); return new Set(); }

    const byGroup = new Map();
    for (const r of data || []) {
        const cur = byGroup.get(r.group_jid) || { total: 0, unresolved: 0 };
        cur.total += 1;
        if (!r.resolved) cur.unresolved += 1;
        byGroup.set(r.group_jid, cur);
    }
    const ready = new Set();
    for (const [jid, s] of byGroup) if (s.total > 0 && s.unresolved === 0) ready.add(jid);
    return ready;
}

module.exports = {
    loadCreds, saveCreds,
    loadKey,   saveKey,   deleteKey,
    wipeAuth,  listEmployeesWithCreds,
    listTrackedChats, getTrackedJidSet, addTrackedChat, removeTrackedChat,
    getReadyGroupSet,
    addParticipantsToGroup, removeParticipantsFromGroup,
};
