require('dotenv').config();

module.exports = {
    // WhatsApp Cloud API Configuration
    WHATSAPP_API_TYPE: process.env.WHATSAPP_API_TYPE || 'cloud', // 'cloud' or 'baileys'
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    WHATSAPP_WEBHOOK_URL: process.env.WHATSAPP_WEBHOOK_URL,

    // Existing Configuration
    ALLOWED_GROUP_NAMES: (process.env.ALLOWED_GROUPS || "")
        .replace(/[\[\]]/g, "") 
        .split(",")
        .map(n => n.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
        .filter(n => n !== ""),
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob',
    ALLOW_PRIVATE_CHATS: process.env.ALLOW_PRIVATE_CHATS === 'true'
};
