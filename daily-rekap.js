const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason } = baileys;
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { initCronScheduler, executeDailyRecap } = require('./cronScheduler');

async function runManualDailyRecap() {
    const sessionDir = path.join(__dirname, 'session');

    if (!fs.existsSync(sessionDir) || fs.readdirSync(sessionDir).length === 0) {
        console.log('\n❌ Sesi login belum ditemukan!');
        console.log('Silakan jalankan bot terlebih dahulu dengan: npm start lalu scan QR Code.\n');
        process.exit(1);
    }

    console.log('\n⏳ Menghubungkan ke WhatsApp untuk mengirim rekap harian 24 jam ke Admin...');

    const { state } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Daily Recap Utility', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('✅ Terhubung ke WhatsApp! Menjalankan rekap harian sekarang...');
            try {
                // Set socket ke cronScheduler agar executeDailyRecap() bisa mengirim
                initCronScheduler(sock);
                await executeDailyRecap();
            } catch (err) {
                console.error('❌ Gagal menjalankan rekap:', err.message);
            } finally {
                await sock.end();
                process.exit(0);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Sesi telah logout. Silakan login ulang via npm start.');
                process.exit(1);
            }
        }
    });
}

runManualDailyRecap();
