require('dotenv').config();

module.exports = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob',
    ALLOW_PRIVATE_CHATS: process.env.ALLOW_PRIVATE_CHATS === 'true',
    GEMINI_GRAPH_MODEL: process.env.GEMINI_GRAPH_MODEL || 'gemini-2.0-flash'
};
