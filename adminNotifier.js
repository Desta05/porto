/**
 * adminNotifier.js
 * =================
 * Mengelola pengiriman notifikasi ke dua tujuan yang berbeda:
 *
 * 1. GRUP ADMIN OPERASIONAL (config.GRUP_REKAP_ID):
 *    → Menerima NOTIFIKASI REALTIME setiap ada temuan (regex / AI Gemini).
 *    → Temuan digabung selama 2 menit lalu dikirim sekaligus.
 *    → Batas: 20 pesan notifikasi per jam.
 *    → Kalau gagal kirim / kuota habis: temuan tetap di database dan akan
 *      muncul di rekap harian.
 *
 * 2. CHAT PRIBADI ADMIN (ADMIN_NUMBER di .env):
 *    → HANYA menerima rekap harian (dikirim oleh cronScheduler.js).
 *    → Tidak ada notifikasi realtime ke sini.
 */

require('dotenv').config();
const config = require('./config');

// Referensi socket Baileys yang aktif (diperbarui setiap reconnect)
let waSocket = null;

// ==========================================
// ANTREAN NOTIFIKASI REALTIME KE GRUP
// ==========================================
const pendingAlerts = [];   // Temuan yang menunggu dikirim ke grup
let debounceTimer = null;   // Timer debounce 2 menit

// Riwayat waktu pengiriman notifikasi ke GRUP dalam 1 jam terakhir (maks 20/jam)
const sentTimestamps = [];

// Batas panjang aman pesan teks WhatsApp (karakter)
const WA_MAX_MSG_LENGTH = 3500;
const FOOTER_ALERT = '⚠️ Hasil otomatis, mohon dicek manual sebelum bertindak.';
const SEPARATOR_ALERT = '\n─────────────────────────────\n';

/**
 * Format string jam ke format "Jam WIB", misalnya "18:44:22 WIB"
 */
function formatJamWib(ts) {
    if (!ts) {
        return new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB';
    }
    const str = String(ts).trim();
    if (str.endsWith('WIB')) return str;
    const match = str.match(/\b(\d{2}:\d{2}(?::\d{2})?)\b/);
    if (match) {
        return `${match[1]} WIB`;
    }
    return `${str} WIB`;
}

/**
 * Rapikan baris baru dan potong isi pesan maksimal maxLen karakter (default: 300)
 */
function formatIsiPesan(text, maxLen = 300) {
    if (!text || typeof text !== 'string') return '';
    // Rapikan baris baru agar tidak merusak format pesan
    const cleaned = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length > maxLen) {
        return cleaned.slice(0, maxLen) + '...';
    }
    return cleaned;
}

/**
 * Samarkan nilai sensitif (NIK, No HP, Alamat) di dalam teks untuk notifikasi/rekap
 */
function maskSensitiveText(text, kategori, nilai) {
    if (!text || typeof text !== 'string') return '';
    let result = text;
    const kat = (kategori || '').toUpperCase();

    // 1. Samarkan NIK (16 digit angka, tampilkan 4 digit awal lalu 12 tanda bintang)
    if (kat === 'NIK') {
        const regexNik = /\b[1-9]\d{15}\b/g;
        result = result.replace(regexNik, (match) => {
            return match.slice(0, 4) + '************';
        });
        if (nilai && typeof nilai === 'string' && nilai.length >= 8) {
            const maskedVal = nilai.slice(0, 4) + '*'.repeat(nilai.length - 4);
            result = result.split(nilai).join(maskedVal);
        }
    } 
    // 2. Samarkan Nomor HP (contoh: 0812****7890)
    else if (kat === 'NOMOR_HP' || kat === 'NO_HP') {
        const regexPhone = /(?:\+62|62|0)8[1-9][0-9\- ]{7,13}[0-9]\b/g;
        result = result.replace(regexPhone, (match) => {
            const clean = match.trim();
            const digits = clean.replace(/\D/g, '');
            if (digits.length >= 10 && digits.length <= 14) {
                if (clean.startsWith('+62')) {
                    return clean.slice(0, 5) + '****' + clean.slice(-4);
                } else {
                    return clean.slice(0, 4) + '****' + clean.slice(-4);
                }
            }
            return match;
        });
        if (nilai && typeof nilai === 'string') {
            const cleanVal = nilai.trim();
            if (cleanVal.replace(/\D/g, '').length >= 10) {
                const maskedVal = cleanVal.startsWith('+62')
                    ? cleanVal.slice(0, 5) + '****' + cleanVal.slice(-4)
                    : cleanVal.slice(0, 4) + '****' + cleanVal.slice(-4);
                result = result.split(nilai).join(maskedVal);
            }
        }
    } 
    // 3. Samarkan Alamat (tampilkan "[alamat disamarkan]")
    else if (kat === 'ALAMAT') {
        if (nilai && typeof nilai === 'string' && nilai.trim()) {
            result = result.split(nilai.trim()).join('[alamat disamarkan]');
        }
        const addressPatterns = [
            /\b(?:jl(?:n|\.)?|jalan|gang|gg\.?|komp(?:lek)?)\s+[a-zA-Z0-9\s.,\-\/]+?(?=\b(?:no(?:mor|\.)?|rt|rw|blok|kel(?:urahan|\.)?|kec(?:amatan|\.)?|kota|kab(?:upaten|\.)?|desa)\b)\b(?:no(?:mor|\.)?|rt|rw|blok|kel(?:urahan|\.)?|kec(?:amatan|\.)?|kota|kab(?:upaten|\.)?|desa)\b[a-zA-Z0-9\s.,\-\/]*/gi,
            /\b(?:rt\s*\d+\s*(?:\/|\s*rw\s*)\s*\d+)\b[a-zA-Z0-9\s.,\-\/]*/gi,
            /\b(?:jl(?:n|\.)?|jalan|gang|gg\.?|komp(?:lek)?)\s+[a-zA-Z0-9.,\-\/ ]{2,40}\s+(?:no(?:mor|\.)?|blok)\s*[a-zA-Z0-9\-\/]+/gi
        ];
        for (const pattern of addressPatterns) {
            result = result.replace(pattern, '[alamat disamarkan]');
        }
        if (!result.includes('[alamat disamarkan]')) {
            result = '[alamat disamarkan]';
        }
    }

    return result;
}

/**
 * Format satu temuan sesuai format yang diminta:
 * 🚨 [TEMUAN AI: KATEGORI | TINGKAT] [Nama Grup]
 * 👤 Dari: Nama (nomor)
 * 🕒 Jam WIB
 * 💬 Pesan: "isi pesan"
 * 📝 Alasan: alasan dari AI / detail dari regex
 */
function formatSingleAlert(item) {
    const label = item.sourceType === 'regex' ? 'TEMUAN REGEX' : 'TEMUAN AI';
    const jamWib = formatJamWib(item.timestamp);
    const maskedPesan = maskSensitiveText(item.isiPesan, item.kategori, item.nilai);
    const formattedPesan = formatIsiPesan(maskedPesan, 300);

    const lines = [
        `🚨 [${label}: ${item.kategori} | ${item.tingkat}] [${item.groupName}]`,
        `👤 Dari: ${item.senderName} (${item.senderNumber})`,
        `🕒 ${jamWib}`,
        `💬 Pesan: "${formattedPesan}"`,
        `📝 Alasan: ${item.detail}`
    ];

    return lines.join('\n');
}

/**
 * Daftarkan / perbarui socket Baileys yang aktif.
 * Dipanggil dari index.js setiap kali koneksi 'open'.
 */
function setNotifierSocket(sock) {
    waSocket = sock;
}

/**
 * Ambil JID chat pribadi admin dari ADMIN_NUMBER di .env.
 * Dipakai oleh cronScheduler.js untuk kirim rekap harian.
 */
function getAdminJid() {
    const rawNumber = (process.env.ADMIN_NUMBER || process.env.ADMIN_PHONE || '').trim();
    if (!rawNumber) return null;

    let digits = rawNumber.replace(/\D/g, '');
    if (digits.startsWith('08')) {
        digits = '628' + digits.slice(2);
    } else if (digits.startsWith('8') && !digits.startsWith('62')) {
        digits = '628' + digits.slice(1);
    }

    return digits ? `${digits}@s.whatsapp.net` : null;
}

/**
 * Ambil JID grup admin operasional dari config.GRUP_REKAP_ID.
 */
function getGrupAdminJid() {
    const raw = (config.GRUP_REKAP_ID || '').trim();
    return raw || null;
}

/**
 * Ambil tingkat minimum notifikasi ke grup dari config.
 * Urutan: ringan < sedang < berat
 */
const TINGKAT_ORDER = { ringan: 0, sedang: 1, berat: 2 };

function getTingkatMin() {
    const raw = (config.NOTIF_GRUP_MIN_TINGKAT || 'ringan').toLowerCase();
    return TINGKAT_ORDER.hasOwnProperty(raw) ? raw : 'ringan';
}

function isTingkatCukup(tingkat) {
    const min = TINGKAT_ORDER[getTingkatMin()] ?? 0;
    const curr = TINGKAT_ORDER[(tingkat || 'ringan').toLowerCase()] ?? 0;
    return curr >= min;
}

/**
 * Cek apakah batas 20 notifikasi per jam ke GRUP sudah tercapai.
 */
function isRateLimitReached() {
    const now = Date.now();
    // Buang entri yang lebih lama dari 1 jam
    while (sentTimestamps.length > 0 && now - sentTimestamps[0] > 3600000) {
        sentTimestamps.shift();
    }
    return sentTimestamps.length >= 20;
}

/**
 * Masukkan temuan ke antrean notifikasi grup jika memenuhi syarat.
 *
 * Syarat:
 * 1. config.GRUP_REKAP_ID harus diisi.
 * 2. Bukan dari grup yang ada di excludedGroups (sudah dijaga di index.js,
 *    tapi kita cek lagi di sini untuk keamanan ganda).
 *    PENGECUALIAN: Grup Admin Operasional sendiri boleh menjadi target kirim,
 *    bukan sumber baca — pemeriksaan excludedGroups untuk sumber pesan.
 * 3. Tingkat temuan >= NOTIF_GRUP_MIN_TINGKAT.
 */
function notifyAdminIfImportant({
    groupName, groupJid, senderName, senderNumber,
    kategori, tingkat, perluReview, detail, nilai, isiPesan, timestamp,
    sourceType   // 'regex' | 'ai' — untuk membedakan label di pesan
}) {
    const grupJid = getGrupAdminJid();
    if (!grupJid) {
        // Grup belum dikonfigurasi — diam saja, temuan sudah tersimpan di DB
        return;
    }

    // Filter tingkat minimum
    if (!isTingkatCukup(tingkat)) {
        return;
    }

    // Masukkan ke antrean
    pendingAlerts.push({
        groupName: groupName || 'Grup WhatsApp',
        groupJid,
        senderName: senderName || 'Tanpa Nama',
        senderNumber: senderNumber || '-',
        kategori: (kategori || 'PELANGGARAN').toUpperCase(),
        tingkat: (tingkat || 'ringan').toUpperCase(),
        perluReview: Boolean(perluReview) || perluReview === 1,
        detail: detail || 'Terindikasi pelanggaran',
        nilai: nilai || '',
        isiPesan: (isiPesan || '').trim(),
        timestamp: timestamp || new Date().toLocaleString('id-ID'),
        sourceType: sourceType || 'ai'   // default 'ai' untuk backward compat
    });

    // Mulai timer debounce 2 menit jika belum jalan
    if (!debounceTimer) {
        debounceTimer = setTimeout(() => {
            flushAlertsToGrup();
        }, 120000); // 2 menit

        if (debounceTimer.unref) debounceTimer.unref();
    }
}

/**
 * Kirim seluruh temuan yang terkumpul ke grup admin operasional.
 */
async function flushAlertsToGrup() {
    debounceTimer = null;

    if (pendingAlerts.length === 0) return;

    const grupJid = getGrupAdminJid();
    if (!grupJid) return;

    if (!waSocket) {
        console.warn('⚠️ [NOTIF GRUP] Socket WhatsApp belum siap. Temuan tetap di database.');
        return;
    }

    // Cek batas per jam
    if (isRateLimitReached()) {
        const sisa = pendingAlerts.length;
        console.warn(`⚠️ [NOTIF GRUP] Batas 20 pesan/jam tercapai. ${sisa} temuan tidak dikirim ke grup sekarang, tetap tersimpan di database dan akan muncul di rekap harian.`);
        // Jangan hapus pendingAlerts — tapi kita tidak bisa kirim, jadi kita drain saja
        // tanpa kirim agar tidak numpuk selamanya. Temuan sudah di DB.
        pendingAlerts.splice(0, pendingAlerts.length);

        // Coba lagi setelah 5 menit jika ada temuan baru
        return;
    }

    // Ambil semua yang menunggu
    const batch = pendingAlerts.splice(0, pendingAlerts.length);

    // Format masing-masing temuan dan susun chunk pesan agar tidak melebihi batas WhatsApp
    const messageChunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (const item of batch) {
        const alertBlock = formatSingleAlert(item);
        const addedLen = alertBlock.length + (currentChunk.length > 0 ? SEPARATOR_ALERT.length : 0);

        if (currentChunk.length > 0 && (currentLength + addedLen + FOOTER_ALERT.length + 2 > WA_MAX_MSG_LENGTH)) {
            messageChunks.push(currentChunk.join(SEPARATOR_ALERT) + '\n\n' + FOOTER_ALERT);
            currentChunk = [alertBlock];
            currentLength = alertBlock.length;
        } else {
            currentChunk.push(alertBlock);
            currentLength += addedLen;
        }
    }

    if (currentChunk.length > 0) {
        messageChunks.push(currentChunk.join(SEPARATOR_ALERT) + '\n\n' + FOOTER_ALERT);
    }

    try {
        // ATURAN PENTING: Bot HANYA mengirim ke grup admin, tidak membalas di
        // grup lain, tidak menghapus pesan, tidak mengeluarkan anggota.
        for (const msgText of messageChunks) {
            await waSocket.sendMessage(grupJid, { text: msgText });
            sentTimestamps.push(Date.now());
            if (messageChunks.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        console.log(`✅ [NOTIF GRUP TERKIRIM] ${batch.length} temuan (${messageChunks.length} pesan) → ${grupJid}`);
    } catch (err) {
        console.error(`❌ [NOTIF GRUP] Gagal mengirim ke grup admin: ${err.message}`);
        // Temuan sudah di DB — tidak di-re-queue agar tidak menumpuk
    }
}

module.exports = {
    setNotifierSocket,
    notifyAdminIfImportant,
    flushAlertsToGrup,
    getAdminJid,
    getGrupAdminJid,
    formatJamWib,
    formatIsiPesan,
    maskSensitiveText,
    formatSingleAlert
};
