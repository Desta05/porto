/**
 * Modul Detektor: Spam & Data Sensitif (100% Regex Murni, Tanpa AI)
 */

const config = require('./config');

const SPAM_JENDELA_DETIK = config.SPAM_JENDELA_DETIK ?? 10;
const SPAM_TEKS_MIN = config.SPAM_TEKS_MIN ?? 3;
const SPAM_STIKER_MIN = config.SPAM_STIKER_MIN ?? 5;
const SPAM_COOLDOWN_DETIK = 60;

// Normalisasi teks: huruf kecil, trim, spasi ganda dijadikan satu
function normalizeText(text) {
    if (typeof text !== 'string') return '';
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Konversi timestamp pesan ke detik (unix epoch seconds)
function resolveTimestampSeconds(ts) {
    if (typeof ts === 'number' && !isNaN(ts) && ts > 0) {
        return ts > 1e11 ? Math.floor(ts / 1000) : Math.floor(ts);
    }
    if (typeof ts === 'string') {
        const parsed = Number(ts);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed > 1e11 ? Math.floor(parsed / 1000) : Math.floor(parsed);
        }
    }
    return Math.floor(Date.now() / 1000);
}

// Memory tracker untuk memantau aktivitas pengirim di setiap grup (sliding window)
// Format key: `${groupJid}:${senderNumber}`
// Format value: {
//   textHistory: [{ text: string, timestamp: number }, ...],
//   stickerHistory: [number, ...],
//   lastSpamTextTs: number,
//   lastSpamStickerTs: number
// }
const spamTracker = new Map();

// Pembersihan berkala memori tracker setiap 2 menit agar RAM tetap bersih
const cleanupInterval = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [key, data] of spamTracker.entries()) {
        data.textHistory = (data.textHistory || []).filter(item => nowSec - item.timestamp <= SPAM_JENDELA_DETIK);
        data.stickerHistory = (data.stickerHistory || []).filter(t => nowSec - t <= SPAM_JENDELA_DETIK);

        const textCooldownExpired = !data.lastSpamTextTs || (nowSec - data.lastSpamTextTs >= SPAM_COOLDOWN_DETIK);
        const stickerCooldownExpired = !data.lastSpamStickerTs || (nowSec - data.lastSpamStickerTs >= SPAM_COOLDOWN_DETIK);

        if (
            data.textHistory.length === 0 &&
            data.stickerHistory.length === 0 &&
            textCooldownExpired &&
            stickerCooldownExpired
        ) {
            spamTracker.delete(key);
        }
    }
}, 120000);

// unref() agar interval ini tidak menghalangi proses node untuk exit jika diperlukan
if (cleanupInterval.unref) {
    cleanupInterval.unref();
}

// Pola Regex untuk NIK (16 digit angka, format resmi kependudukan Indonesia)
const REGEX_NIK = /\b[1-9]\d{15}\b/g;

// Pola Regex untuk Nomor HP Indonesia (+62, 62, atau 08 diikuti 8-12 digit)
const REGEX_PHONE = /(?:\+62|62|0)8[1-9][0-9\- ]{7,13}[0-9]\b/g;

/**
 * Deteksi Alamat Bahasa Indonesia menggunakan pola kata kunci geografis
 */
function detectAddresses(text) {
    if (!text || typeof text !== 'string') return [];

    const patterns = [
        // Pola 1: Jl/Jalan/Gang/Komplek diikuti nama dan No/RT/RW/Blok/Kec/Kota
        /\b(?:jl(?:n|\.)?|jalan|gang|gg\.?|komp(?:lek)?)\s+[a-zA-Z0-9\s.,\-\/]+?(?=\b(?:no(?:mor|\.)?|rt|rw|blok|kel(?:urahan|\.)?|kec(?:amatan|\.)?|kota|kab(?:upaten|\.)?|desa)\b)\b(?:no(?:mor|\.)?|rt|rw|blok|kel(?:urahan|\.)?|kec(?:amatan|\.)?|kota|kab(?:upaten|\.)?|desa)\b[a-zA-Z0-9\s.,\-\/]*/gi,

        // Pola 2: Format RT & RW spesifik
        /\b(?:rt\s*\d+\s*(?:\/|\s*rw\s*)\s*\d+)\b[a-zA-Z0-9\s.,\-\/]*/gi,

        // Pola 3: Jalan/Gang/Komplek dengan Nomor Rumah
        /\b(?:jl(?:n|\.)?|jalan|gang|gg\.?|komp(?:lek)?)\s+[a-zA-Z0-9.,\-\/ ]{2,40}\s+(?:no(?:mor|\.)?|blok)\s*[a-zA-Z0-9\-\/]+/gi
    ];

    const rawSet = new Set();
    for (const regex of patterns) {
        const matches = text.match(regex);
        if (matches) {
            for (const item of matches) {
                const cleaned = item.trim().replace(/[\r\n]+/g, ' ');
                if (cleaned.length >= 8) {
                    rawSet.add(cleaned);
                }
            }
        }
    }

    // Urutkan dari yang terpanjang ke terpendek agar sub-string tidak ganda
    const sorted = Array.from(rawSet).sort((a, b) => b.length - a.length);
    const filtered = [];
    for (const item of sorted) {
        if (!filtered.some(existing => existing.includes(item))) {
            filtered.push(item);
        }
    }

    return filtered;
}

/**
 * Analisis pesan untuk mendeteksi SPAM dan Data Sensitif (NIK, No HP, Alamat)
 * @param {Object} params
 * @returns {Array<Object>} Daftar temuan yang terdeteksi
 */
function analyzeMessage({ groupJid, senderNumber, messageType, messageContent, timestamp }) {
    const findings = [];
    const msgTime = resolveTimestampSeconds(timestamp);
    const trackerKey = `${groupJid}:${senderNumber}`;

    // ==========================================
    // 1. DETEKSI SPAM (Sliding Window di Memori)
    // Reaksi emoji dan pesan sistem tidak dihitung
    // ==========================================
    const isSpamEligible = messageType === 'teks' || messageType === 'stiker';

    if (isSpamEligible) {
        // Ambil atau buat status tracker pengirim
        let userState = spamTracker.get(trackerKey);
        if (!userState) {
            userState = {
                textHistory: [],
                stickerHistory: [],
                lastSpamTextTs: 0,
                lastSpamStickerTs: 0
            };
            spamTracker.set(trackerKey, userState);
        }

        // Aturan 1: Teks sama berulang
        if (messageType === 'teks') {
            const normalized = normalizeText(messageContent);
            if (normalized.length > 0) {
                userState.textHistory.push({ text: normalized, timestamp: msgTime });

                // Sliding window: pertahankan pesan dalam SPAM_JENDELA_DETIK
                const minValidTs = msgTime - SPAM_JENDELA_DETIK;
                userState.textHistory = userState.textHistory.filter(
                    item => item.timestamp >= minValidTs && item.timestamp <= msgTime + 5
                );

                // Hitung kemunculan teks identik dalam jendela waktu
                const matching = userState.textHistory.filter(item => item.text === normalized);
                const count = matching.length;

                if (count >= SPAM_TEKS_MIN) {
                    // Cooldown 60 detik per pengirim per jenis spam teks
                    const inCooldown = userState.lastSpamTextTs > 0 &&
                        Math.abs(msgTime - userState.lastSpamTextTs) < SPAM_COOLDOWN_DETIK;

                    if (!inCooldown) {
                        userState.lastSpamTextTs = msgTime;

                        const oldestTs = Math.min(...matching.map(m => m.timestamp));
                        const newestTs = Math.max(...matching.map(m => m.timestamp));
                        const durasi = Math.max(0, newestTs - oldestTs);

                        const tingkat = count >= (2 * SPAM_TEKS_MIN) ? 'sedang' : 'ringan';

                        findings.push({
                            kategori: 'SPAM',
                            tingkat: tingkat,
                            perlu_review: false,
                            detail: `Mengirim teks yang sama ${count} kali dalam ${durasi} detik`,
                            nilai: `${count} teks / ${durasi} detik`
                        });
                    }
                }
            }
        }

        // Aturan 2: Stiker beruntun
        if (messageType === 'stiker') {
            userState.stickerHistory.push(msgTime);

            // Sliding window: pertahankan stiker dalam SPAM_JENDELA_DETIK
            const minValidTs = msgTime - SPAM_JENDELA_DETIK;
            userState.stickerHistory = userState.stickerHistory.filter(
                t => t >= minValidTs && t <= msgTime + 5
            );

            const count = userState.stickerHistory.length;

            if (count >= SPAM_STIKER_MIN) {
                // Cooldown 60 detik per pengirim per jenis spam stiker
                const inCooldown = userState.lastSpamStickerTs > 0 &&
                    Math.abs(msgTime - userState.lastSpamStickerTs) < SPAM_COOLDOWN_DETIK;

                if (!inCooldown) {
                    userState.lastSpamStickerTs = msgTime;

                    const oldestTs = Math.min(...userState.stickerHistory);
                    const newestTs = Math.max(...userState.stickerHistory);
                    const durasi = Math.max(0, newestTs - oldestTs);

                    const tingkat = count >= (2 * SPAM_STIKER_MIN) ? 'sedang' : 'ringan';

                    findings.push({
                        kategori: 'SPAM',
                        tingkat: tingkat,
                        perlu_review: false,
                        detail: `Mengirim ${count} stiker dalam ${durasi} detik`,
                        nilai: `${count} stiker / ${durasi} detik`
                    });
                }
            }
        }
    }

    // ==========================================
    // 2. DETEKSI REGEX: NIK, NOMOR HP, ALAMAT
    // ==========================================
    const textToCheck = typeof messageContent === 'string' ? messageContent : '';

    if (textToCheck.length > 0) {
        // 2A. Deteksi NIK (16 Digit - Sangat Sensitif)
        const nikMatches = textToCheck.match(REGEX_NIK);
        if (nikMatches) {
            const uniqueNiks = [...new Set(nikMatches)];
            for (const nik of uniqueNiks) {
                findings.push({
                    kategori: 'NIK',
                    tingkat: 'berat',
                    perlu_review: true,
                    detail: `Kebocoran NIK terdeteksi (${nik.length} digit)`,
                    nilai: nik
                });
            }
        }

        // 2B. Deteksi Nomor HP Indonesia
        const rawPhones = textToCheck.match(REGEX_PHONE);
        if (rawPhones) {
            const validPhones = new Set();
            for (const p of rawPhones) {
                const digits = p.replace(/\D/g, '');
                // Nomor HP Indonesia umumnya 10 - 14 digit
                if (digits.length >= 10 && digits.length <= 14) {
                    validPhones.add(p.trim());
                }
            }

            for (const phone of validPhones) {
                findings.push({
                    kategori: 'NOMOR_HP',
                    tingkat: 'sedang',
                    perlu_review: false,
                    detail: `Nomor HP terdeteksi dalam pesan`,
                    nilai: phone
                });
            }
        }

        // 2C. Deteksi Alamat (Doxxing / Privasi)
        const addresses = detectAddresses(textToCheck);
        for (const addr of addresses) {
            findings.push({
                kategori: 'ALAMAT',
                tingkat: 'berat',
                perlu_review: true,
                detail: `Pola alamat tempat tinggal terdeteksi`,
                nilai: addr
            });
        }
    }

    return findings;
}

module.exports = {
    analyzeMessage,
    detectAddresses,
    normalizeText,
    spamTracker
};
