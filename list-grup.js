const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason } = baileys;
const pino = require('pino');
const path = require('path');
const fs = require('fs');

async function listAllGroups() {
    const sessionDir = path.join(__dirname, 'session');

    // Cek apakah sesi login sudah ada
    if (!fs.existsSync(sessionDir) || fs.readdirSync(sessionDir).length === 0) {
        console.log('\n❌ Sesi login belum ditemukan!');
        console.log('Silakan jalankan bot terlebih dahulu dengan perintah: npm start');
        console.log('Lalu scan QR Code dengan WhatsApp di HP Anda.\n');
        process.exit(1);
    }

    console.log('\n⏳ Menghubungkan ke WhatsApp untuk mengambil daftar grup...');

    const { state } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['List Group Utility', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('✅ Terhubung! Mengambil data seluruh grup WhatsApp...\n');

            try {
                // Mengambil seluruh grup yang diikuti bot (termasuk grup komunitas)
                const groups = await sock.groupFetchAllParticipating();
                const groupList = Object.values(groups);

                if (groupList.length === 0) {
                    console.log('⚠️ Bot belum bergabung ke grup mana pun di akun WhatsApp ini.');
                } else {
                    console.log('='.repeat(80));
                    console.log(`📋 DAFTAR GRUP WHATSAPP YANG DIIKUTI BOT (Total: ${groupList.length} Grup)`);
                    console.log('='.repeat(80));

                    const displayData = groupList.map((g, index) => ({
                        'No': index + 1,
                        'Nama Grup': g.subject || 'Tanpa Nama',
                        'ID Grup (Salin ID Ini)': g.id,
                        'Anggota': `${(g.participants || []).length} orang`,
                        'Komunitas': g.isCommunity ? 'Induk Komunitas' : (g.isCommunityAnnounce ? 'Pengumuman Komunitas' : 'Grup Standar')
                    }));

                    console.table(displayData);

                    console.log('='.repeat(80));
                    console.log('💡 CARA MENGECEK / MENGEQUALIKAN GRUP:');
                    console.log('1. Salin "ID Grup" (misal: 120363012345678901@g.us) dari tabel di atas.');
                    console.log('2. Buka file "config.js" lalu tempelkan ID tersebut ke array "excludedGroups".');
                    console.log('3. Pesan dari grup tersebut akan diabaikan secara total oleh bot.');
                    console.log('='.repeat(80) + '\n');
                }
            } catch (err) {
                console.error('❌ Gagal mengambil daftar grup:', err.message);
            } finally {
                // Tutup koneksi secara bersih
                await sock.end();
                process.exit(0);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Sesi telah logout. Silakan hapus folder "session" lalu login ulang lewat npm start.');
                process.exit(1);
            }
        }
    });
}

listAllGroups();
