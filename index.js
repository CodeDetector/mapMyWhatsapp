const { app, initAllSessions, run } = require('./processorCloudAPI');
const PORT = process.env.PORT || 3001;

// Start the Express server for webhook
app.listen(PORT, () => {
    console.log(`📡 WhatsApp Cloud API Manager listening on port ${PORT}`);
    console.log(`📧 Webhook endpoint: POST http://localhost:${PORT}/webhook`);
    console.log(`🔐 Webhook verification endpoint: GET http://localhost:${PORT}/webhook`);
});

// Initialize all sessions
if (require.main === module) {
    run();
}

module.exports = {
    app,
    run,
    initAllSessions
};
