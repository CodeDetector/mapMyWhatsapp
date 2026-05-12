// Refinement-agent enqueue helper (mapMyWhatsapp side).
// Mirror of mapMyBusiness/queue.js — kept in sync by hand.

const supabaseService = require('./supabaseService');

async function enqueue({ channel, sourceTable, sourceId, payload }) {
    if (!supabaseService.client) {
        console.warn('mapMyWhatsapp/queue: supabase client unavailable, skipping enqueue');
        return null;
    }
    if (!channel || !sourceTable) {
        console.error('mapMyWhatsapp/queue.enqueue: channel and sourceTable required');
        return null;
    }
    try {
        const { data, error } = await supabaseService.client
            .from('agent_jobs')
            .insert([{
                channel,
                source_table: sourceTable,
                source_id: sourceId ?? null,
                payload: payload || {},
            }])
            .select('id')
            .single();
        if (error) throw error;
        return data;
    } catch (err) {
        // Never let queue failures break message ingestion.
        console.error('mapMyWhatsapp/queue.enqueue failed:', err.message);
        return null;
    }
}

module.exports = { enqueue };
