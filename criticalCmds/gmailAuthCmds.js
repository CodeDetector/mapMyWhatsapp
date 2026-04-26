const { gmailService } = require('wa-field-tracker-feeder-email');
const supabaseService = require('../supabaseService');

async function handleConnectGmail(sock, remoteJid) {
    const authUrl = gmailService.getAuthUrl();
    if (authUrl) {
        await sock.sendMessage(remoteJid, { 
            text: `🔗 *OMNI-BRAIN AUTH* 🔗\n\n1. Open: ${authUrl}\n\n2. Authorize and copy the code.\n\n3. Reply here with: !gmail code YOUR_CODE` 
        });
    }
}

async function handleGmailCode(sock, remoteJid, msg, text) {
    const code = text.replace('!gmail code ', '').trim();
    const senderNum = (msg.key.participant || remoteJid).split('@')[0];
    
    console.log(`🔐 Attempting Vault Save for ${senderNum}...`);
    try {
        const employeeId = await supabaseService.getEmployeeId(senderNum);
        if (!employeeId) throw new Error(`Phone number ${senderNum} is not registered in the Employees table.`);

        const tokens = await gmailService.getTokens(code);
        const success = await supabaseService.saveEmployeeToken(employeeId, 'gmail', tokens);
        
        if (success) {
            await supabaseService.toggleIntegration(employeeId, 'gmail', true);
            try {
                const profile = await gmailService.getProfile(tokens);
                if (profile && profile.emailAddress) {
                    await supabaseService.updateEmployeeEmail(employeeId, profile.emailAddress);
                    await sock.sendMessage(remoteJid, { text: `✅ *VAULT SECURED* ✅\n\nYour inbox (*${profile.emailAddress}*) is now connected. OMNI-BRAIN is monitoring your Gmail.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: '✅ *VAULT SECURED* ✅\n\nYour Gmail credentials have been moved to the encrypted vault.' });
                }
            } catch (profErr) {
                console.error('⚠️ Could not fetch Gmail profile:', profErr.message);
                await sock.sendMessage(remoteJid, { text: '✅ *VAULT SECURED* ✅\n\nCredentials saved, but could not verify email address.' });
            }
        } else {
            throw new Error('Database Vault RPC failed.');
        }
    } catch (err) {
        console.error('❌ Vault Error:', err.message);
        await sock.sendMessage(remoteJid, { text: `❌ *VAULT ERROR*\n\nReason: ${err.message}` });
    }
}

module.exports = {
    handleConnectGmail,
    handleGmailCode
};
