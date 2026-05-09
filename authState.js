/**
 * Supabase-backed Baileys auth state.
 * Drop-in replacement for `useMultiFileAuthState` that stores creds + Signal
 * protocol keys in Postgres instead of the local filesystem, so multiple
 * employees can be authenticated in parallel and survive process restarts.
 */
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const waAuthRepo = require('./waAuthRepo');

// Convert Buffer-containing object to JSON-safe form for JSONB storage.
const toJsonSafe   = (obj) => JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
// Restore Buffer instances when reading back from JSONB.
const fromJsonSafe = (obj) => obj == null ? null : JSON.parse(JSON.stringify(obj), BufferJSON.reviver);

async function useSupabaseAuthState(employeeId) {
    // Load existing creds, or mint fresh ones for a brand-new pairing.
    const stored = await waAuthRepo.loadCreds(employeeId);
    const creds  = stored ? fromJsonSafe(stored) : initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const out = {};
                    await Promise.all(ids.map(async (id) => {
                        const raw = await waAuthRepo.loadKey(employeeId, type, id);
                        if (!raw) return;
                        let value = fromJsonSafe(raw);
                        // app-state-sync-key needs to be re-instantiated as a proto message
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        out[id] = value;
                    }));
                    return out;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            if (value) {
                                tasks.push(waAuthRepo.saveKey(employeeId, category, id, toJsonSafe(value)));
                            } else {
                                tasks.push(waAuthRepo.deleteKey(employeeId, category, id));
                            }
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: async () => {
            await waAuthRepo.saveCreds(employeeId, toJsonSafe(creds));
        },
    };
}

module.exports = { useSupabaseAuthState };
