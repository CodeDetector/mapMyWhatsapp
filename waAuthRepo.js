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

module.exports = {
    loadCreds, saveCreds,
    loadKey,   saveKey,   deleteKey,
    wipeAuth,  listEmployeesWithCreds,
    listTrackedChats, getTrackedJidSet, addTrackedChat, removeTrackedChat,
};
