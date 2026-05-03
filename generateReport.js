const supabaseService = require('./supabaseService');
const intelligenceService = require('./intelligenceService');
const { managerScreeningReportPrompt, employeeScreeningReportPrompt } = require('./prompts');

async function generateAndSendReport(messageSender) {
    console.log('📊 Starting Cross-Channel Report Generation...');
    
    try {
        const managers = await supabaseService.getManagers();
        console.log(`👨‍💼 Found ${managers.length} managers to report to.`);

        for (const manager of managers) {
            const employees = await supabaseService.getEmployeesByManager(manager.id);
            console.log(`👥 Manager ${manager.Name} has ${employees.length} employees.`);

            // Extract phone number (works for Cloud API)
            const managerPhone = manager.Mobile.replace(/\D/g, '');

            for (const emp of employees) {
                console.log(`📝 Processing report for ${emp.Name}...`);

                // 1. Fetch Data
                const messages = await supabaseService.getMessagesByEmployeeId(emp.id, 5);
                const emails = await supabaseService.getEmailsByEmployeeId(emp.id, 5);
                const graphData = await supabaseService.getGraphContext(emp.Name);

                // 2. Prep Log String
                let logBlob = "";
                messages.forEach(m => logBlob += `[WA] [${m.created_at}] ${m.messageType}: ${m.description}\n`);
                emails.forEach(e => logBlob += `[MAIL] [${e.created_at}] From: ${e.sender} To: ${e.receiver}\nContent: ${e.message}\n`);

                if (messages.length === 0 && emails.length === 0) {
                    console.log(`⏭️ No activity for ${emp.Name}. Skipping.`);
                    continue;
                }

                // 3. Knowledge Graph Context
                let graphContext = "No deep relationship insights found for this period.";
                if (graphData && graphData.relationships?.length > 0) {
                    graphContext = graphData.relationships.map(r => 
                       `- *${r.from_node.name}* ${r.relationship_type.toLowerCase()} *${r.to_node.name}* (${JSON.stringify(r.properties)})`
                    ).join('\n');
                }

                // 4. Generate Reports via Gemini
                const managerPrompt = managerScreeningReportPrompt(emp, logBlob, graphContext);
                const employeePrompt = employeeScreeningReportPrompt(emp, logBlob, graphContext);

                // 5. Send to WhatsApp
                const empPhone = emp.Mobile.replace(/\D/g, '');

                // Sending to Employee (Encouraging tone)
                if (messageSender && messageSender.sendMessage) {
                    try {
                        await messageSender.sendMessage(empPhone, { 
                            text: `👋 *Omni-Brain Weekly Digest*\n\nGenerating your personal summary...` 
                        });
                    } catch (err) {
                        console.warn(`⚠️ Could not send message to employee ${emp.Name}:`, err.message);
                    }
                }

                // Send manager report
                if (messageSender && messageSender.sendMessage) {
                    try {
                        await messageSender.sendMessage(managerPhone, { 
                            text: `📊 *Manager Report for ${emp.Name}*\n\n${managerPrompt}` 
                        });
                    } catch (err) {
                        console.warn(`⚠️ Could not send report to manager:`, err.message);
                    }
                }
            }
        }
    } catch (err) {
        console.error('❌ Report Generation Failure:', err.message);
    }
}

module.exports = { generateAndSendReport };
