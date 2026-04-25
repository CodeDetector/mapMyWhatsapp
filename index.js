const whatsappProcessor = require('./processor');

function run() {
    console.log('📱 Starting OMNI-BRAIN: WhatsApp Container...');
    whatsappProcessor.connectToWhatsApp().catch(err => {
        console.error('❌ WhatsApp Container Crash:', err.message);
        process.exit(1);
    });
}

if (require.main === module) {
    run();
}

module.exports = {
    whatsappProcessor,
    run
};
