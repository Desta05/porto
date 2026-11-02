require('dotenv').config();
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason } = baileys;
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const path = require('path');
const config = require('./config');
const { initDatabase, saveGroupMessage, saveTemuan } = require('./database');
const { analyzeMessage } = require('./detector');
const { queueMessageForAI } = require('./geminiModerator');
const { setNotifierSocket, notifyAdminIfImportant, getAdminJid } = require('./adminNotifier');
const { formatJakartaTimestamp } = require('./timeHelper');
const { initCronScheduler } = require('./cronScheduler');

// Inisialisasi database SQLite saat bot pertama kali dijalankan
initDatabase();

// Cache nama grup di memori (groupJid => groupName)
const groupCache = new Map();

async function startBot() {
    // Menyimpan kredensial sesi WhatsApp di folder 'session' agar tidak perlu scan ulang setiap restart
    const sessionDir = path.join(__dirname, 'session');
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // Konfigurasi koneksi Baileys
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Mengheningkan log internal agar terminal tetap bersih
        printQRInTerminal: false,           // Kita pakai qrcode-terminal khusus agar tampilan QR rapi
        browser: ['Security Bot', 'Chrome', '1.0.0']
    });

    // Daftarkan socket ke modul notifikasi admin agar bot dapat mengirim pesan pribadi ke admin
    setNotifierSocket(sock);

    // Event: Update status koneksi (QR Code, Terhubung, atau Terputus)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Tampilkan QR Code di terminal jika diminta
        if (qr) {
            console.log('\n' + '='.repeat(54));
            console.log('📌 SCAN QR CODE DI BAWAH INI DENGAN WHATSAPP HP:');
            console.log('1. Buka aplikasi WhatsApp di HP kamu');
            console.log('2. Buka Menu (titik tiga kanan atas) > "Perangkat tertaut"');
            console.log('3. Tekan tombol "Tautkan Perangkat" lalu arahkan kamera ke QR');
            console.log('='.repeat(54) + '\n');
            qrcode.generate(qr, { small: true });
        }

        // Jika koneksi terputus
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`\n⚠️ Koneksi terputus (Kode: ${statusCode}). Mencoba menghubungkan ulang: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000);
            } else {
                console.log('❌ Anda telah logout dari WhatsApp.');
                console.log('Silakan hapus folder "session" lalu jalankan ulang bot untuk scan QR baru.');
            }
        } else if (connection === 'open') {
            console.log('\n' + '='.repeat(65));
            console.log('🎉 BOT WHATSAPP BERHASIL TERHUBUNG!');
            console.log('🤖 Mengawasi SEMUA grup yang diikuti (termasuk Komunitas)...');

            const adminJid = getAdminJid();
            if (adminJid) {
                console.log(`📱 Notifikasi admin aktif: target chat pribadi -> ${adminJid}`);
            } else {
                console.log(`ℹ️ Notifikasi admin belum aktif (ADMIN_NUMBER belum diisi di .env).`);
            }

            // Inisialisasi penjadwalan otomatis rekap harian jam 23.00 WIB
            initCronScheduler(sock);

            // Ambil dan simpan nama semua grup ke cache memori
            try {
                const allGroups = await sock.groupFetchAllParticipating();
                for (const [jid, meta] of Object.entries(allGroups)) {
                    groupCache.set(jid, meta.subject || 'Grup WhatsApp');
                }
                console.log(`📋 Memuat ${groupCache.size} nama grup ke cache memori.`);
                if (config.excludedGroups && config.excludedGroups.length > 0) {
                    console.log(`🚫 ${config.excludedGroups.length} grup berada dalam daftar PENGECUALIAN (config.js).`);
                }
            } catch (err) {
                console.warn('⚠️ Gagal mengambil daftar awal grup:', err.message);
            }
            console.log('='.repeat(65) + '\n');
        }
    });

    // Simpan kredensial setiap kali diperbarui
    sock.ev.on('creds.update', saveCreds);

    // Event jika nama grup diperbarui
    sock.ev.on('groups.update', (updates) => {
        for (const u of updates) {
            if (u.id && u.subject) {
                groupCache.set(u.id, u.subject);
            }
        }
    });

    // Event: Menerima pesan baru
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Hanya proses pesan baru real-time (type: 'notify')
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                const remoteJid = msg.key?.remoteJid;

                // TUJUAN 4: Abaikan pesan yang dikirim oleh bot sendiri
                if (msg.key.fromMe) continue;

                // 1. FILTER: Bot hanya memproses pesan dari SEMUA grup WhatsApp (termasuk Komunitas)
                if (!remoteJid || !remoteJid.endsWith('@g.us')) {
                    continue;
                }

                // 2. FILTER PENGECUALIAN (config.js):
                // Jika ID grup terdaftar di config.excludedGroups, abaikan total:
                // tidak disimpan, tidak dicek spam/doxxing, tidak dikirim ke Gemini.
                if (config.excludedGroups && config.excludedGroups.includes(remoteJid)) {
                    continue;
                }

                // Lewati pesan kosong atau pesan protokol status
                if (!msg.message) continue;

                // Ambil / Perbarui Nama Grup dari cache atau metadata
                let groupName = groupCache.get(remoteJid);
                if (!groupName) {
                    try {
                        const meta = await sock.groupMetadata(remoteJid);
                        groupName = meta.subject || 'Grup WhatsApp';
                        groupCache.set(remoteJid, groupName);
                    } catch {
                        groupName = 'Grup WhatsApp';
                    }
                }

                // Ekstrak Pengirim (di grup WhatsApp, pengirim ada di participant)
                const senderJid = msg.key.participant || msg.participant || '';
                const senderNumber = senderJid.replace(/@.+/, '');
                const senderName = msg.pushName || 'Tanpa Nama';

                // Ekstrak Waktu Pesan secara konsisten dalam zona waktu Asia/Jakarta (WIB)
                const rawTimestamp = msg.messageTimestamp;
                const timestampSeconds = typeof rawTimestamp === 'object' && rawTimestamp !== null
                    ? rawTimestamp.low || Number(rawTimestamp)
                    : Number(rawTimestamp) || Math.floor(Date.now() / 1000);

                const formattedTime = formatJakartaTimestamp(timestampSeconds);

                // Ekstrak Jenis Pesan dan Isinya
                let content = msg.message;
                if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
                if (content.viewOnceMessage?.message) content = content.viewOnceMessage.message;
                if (content.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;

                let messageType = 'lainnya';
                let messageContent = '';

                if (content.conversation) {
                    messageType = 'teks';
                    messageContent = content.conversation;
                } else if (content.extendedTextMessage) {
                    messageType = 'teks';
                    messageContent = content.extendedTextMessage.text || '';
                } else if (content.imageMessage) {
                    messageType = 'gambar';
                    messageContent = content.imageMessage.caption ? `[Gambar]: ${content.imageMessage.caption}` : '[Gambar tanpa caption]';
                } else if (content.stickerMessage) {
                    messageType = 'stiker';
                    messageContent = '[Stiker]';
                } else if (content.audioMessage) {
                    if (content.audioMessage.ptt) {
                        messageType = 'VN';
                        messageContent = '[Voice Note / Pesan Suara]';
                    } else {
                        messageType = 'audio';
                        messageContent = '[File Audio]';
                    }
                } else if (content.videoMessage) {
                    messageType = 'video';
                    messageContent = content.videoMessage.caption ? `[Video]: ${content.videoMessage.caption}` : '[Video]';
                } else if (content.documentMessage) {
                    messageType = 'dokumen';
                    messageContent = `[Dokumen]: ${content.documentMessage.fileName || 'file'}`;
                } else if (content.reactionMessage) {
                    messageType = 'reaksi';
                    messageContent = `[Reaksi Emotikon]: ${content.reactionMessage.text || ''}`;
                } else {
                    const firstKey = Object.keys(content)[0] || 'tidak_diketahui';
                    messageType = firstKey;
                    messageContent = `[${firstKey}]`;
                }

                // 3. Simpan ke database SQLite (Tabel group_messages) dengan timestamp Asia/Jakarta
                const saved = saveGroupMessage({
                    messageId: msg.key.id,
                    timestamp: formattedTime,
                    groupJid: remoteJid,
                    groupName: groupName,
                    senderNumber: senderNumber,
                    senderName: senderName,
                    messageType: messageType,
                    messageContent: messageContent
                });

                if (saved) {
                    console.log(`📥 [LOG GRUP: "${groupName}"] [${formattedTime} WIB] [${messageType.toUpperCase()}] ${senderName} (${senderNumber}): ${messageContent}`);
                }

                // 4. Deteksi Realtime: Spam & Data Sensitif (Regex Murni, Tanpa AI)
                const findings = analyzeMessage({
                    groupJid: remoteJid,
                    senderNumber: senderNumber,
                    messageType: messageType,
                    messageContent: messageContent,
                    timestamp: timestampSeconds
                });

                for (const item of findings) {
                    saveTemuan({
                        messageId: msg.key.id,
                        timestamp: formattedTime,
                        groupJid: remoteJid,
                        groupName: groupName,
                        senderNumber: senderNumber,
                        senderName: senderName,
                        kategori: item.kategori,
                        tingkat: item.tingkat,
                        perluReview: item.perlu_review,
                        detail: item.detail,
                        nilai: item.nilai,
                        isiPesan: messageContent
                    });

                    console.log(`🚨 [TEMUAN REGEX: ${item.kategori} | ${(item.tingkat || 'sedang').toUpperCase()}] [${groupName}] ${senderName} (${senderNumber}): ${item.detail} | Nilai: "${item.nilai}"`);

                    // Kirim notifikasi ke grup Admin Operasional (SEMUA tingkat >= NOTIF_GRUP_MIN_TINGKAT)
                    notifyAdminIfImportant({
                        groupName: groupName,
                        groupJid: remoteJid,
                        senderName: senderName,
                        senderNumber: senderNumber,
                        kategori: item.kategori,
                        tingkat: item.tingkat,
                        perluReview: item.perlu_review,
                        detail: item.detail,
                        nilai: item.nilai,
                        isiPesan: messageContent,
                        timestamp: formattedTime,
                        sourceType: 'regex'  // Temuan dari detektor regex
                    });
                }

                // 5. Masukkan ke Antrean AI Gemini (Batch 60 detik per grup dengan filter ketat)
                queueMessageForAI({
                    messageId: msg.key.id,
                    timestamp: formattedTime,
                    groupJid: remoteJid,
                    groupName: groupName,
                    senderNumber: senderNumber,
                    senderName: senderName,
                    messageType: messageType,
                    messageContent: messageContent
                });

            } catch (err) {
                console.error('⚠️ Terjadi kesalahan saat membaca pesan:', err.message);
            }
        }
    });
}

// Jalankan bot
startBot();
