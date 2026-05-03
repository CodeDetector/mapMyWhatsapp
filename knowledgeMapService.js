const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const { knowledgeMapSynthesisPrompt } = require('./prompts');
const supabaseService = require('./supabaseService');

class KnowledgeMapService {
    constructor() {
        this.genAI = null;
        if (config.GEMINI_API_KEY) {
            this.genAI = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
        }
        this._intervalRef = null;
    }

    /**
     * Starts the 15-minute rebuild cycle.
     * Each tick: find all dirty knowledge maps → rebuild them via Gemini → save.
     */
    start() {
        if (this._intervalRef) return; // already running

        console.log('🗺️  KnowledgeMapService: Starting 15-minute rebuild cycle.');

        // Run once immediately on startup, then every 15 minutes
        this._tick();
        this._intervalRef = setInterval(() => this._tick(), 15 * 60 * 1000);
    }

    stop() {
        if (this._intervalRef) {
            clearInterval(this._intervalRef);
            this._intervalRef = null;
            console.log('🗺️  KnowledgeMapService: Stopped.');
        }
    }

    async _tick() {
        try {
            const dirtyMaps = await supabaseService.getDirtyKnowledgeMaps();
            if (dirtyMaps.length === 0) {
                console.log('🗺️  KnowledgeMapService: No dirty maps. Sleeping.');
                return;
            }

            console.log(`🗺️  KnowledgeMapService: Found ${dirtyMaps.length} dirty knowledge map(s). Rebuilding...`);

            for (const km of dirtyMaps) {
                await this._rebuildMap(km);
            }

            console.log(`✅ KnowledgeMapService: Rebuild cycle complete.`);
        } catch (err) {
            console.error('❌ KnowledgeMapService tick error:', err.message);
        }
    }

    async _rebuildMap(km) {
        if (!this.genAI) {
            console.error('❌ KnowledgeMapService: GEMINI_API_KEY not configured.');
            return;
        }

        try {
            // 1. Resolve employee name
            const employee = await supabaseService.getEmployeeById
                ? await supabaseService.getEmployeeById(km.employee_id)
                : null;
            const empName = employee?.Name || `Employee-${km.employee_id}`;

            // 2. Fetch new interactions since last rebuild
            const { messages, emails } = await supabaseService.getNewInteractionsSince(
                km.employee_id,
                km.last_rebuilt_at
            );

            if (messages.length === 0 && emails.length === 0) {
                // Dirty flag set but no new data (edge case: data was deleted)
                // Just clear the dirty flag
                await supabaseService.saveKnowledgeMap(km.id, km.knowledge_map);
                console.log(`⏭️  KnowledgeMapService: No new data for ${empName}. Cleared dirty flag.`);
                return;
            }

            // 3. Build the interaction log string
            let interactionLog = '';
            messages.forEach(m => {
                interactionLog += `[WHATSAPP] [${m.created_at}] ${m.messageType || 'Text'}: ${m.description}\n`;
            });
            emails.forEach(e => {
                interactionLog += `[EMAIL] [${e.created_at}] From: ${e.sender} To: ${e.receiver}\nContent: ${e.message}\n\n`;
            });

            // 4. Build prompt
            const existingMapStr = JSON.stringify(km.knowledge_map || {}, null, 2);
            const prompt = knowledgeMapSynthesisPrompt(empName, km.employee_id, existingMapStr, interactionLog);

            // 5. Call Gemini
            console.log(`🧠 KnowledgeMapService: Rebuilding map for ${empName} (${messages.length} msgs, ${emails.length} emails)...`);

            const result = await this.genAI.models.generateContent({
                model: 'gemini-2.0-flash',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            const responseText = result.text.replace(/```json|```/g, '').trim();

            let newMap;
            try {
                newMap = JSON.parse(responseText);
            } catch (jsonErr) {
                console.error(`❌ KnowledgeMapService: Failed to parse AI output for ${empName}:`, responseText.substring(0, 200));
                return;
            }

            // 6. Save to Supabase
            await supabaseService.saveKnowledgeMap(km.id, newMap);
            console.log(`✅ KnowledgeMapService: Map updated for ${empName}.`);
        } catch (err) {
            console.error(`❌ KnowledgeMapService: Rebuild failed for employee ${km.employee_id}:`, err.message);
        }
    }
}

module.exports = new KnowledgeMapService();
