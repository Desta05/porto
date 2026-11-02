require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { saveTemuan, getPreviousGroupMessages, getMessageById } = require('./database');
const { notifyAdminIfImportant } = require('./adminNotifier');

// Inisialisasi Google Gen AI
const apiKey = (process.env.GEMINI_API_KEY || '').trim();
const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

let ai = null;
if (apiKey) {
    ai = new GoogleGenAI({ apiKey });
    console.log(`🧠 Google Gemini AI aktif (Model: ${modelName})`);
} else {
    console.warn('⚠️ GEMINI_API_KEY belum disetel di file .env. Fitur AI tidak aktif.');
}

// Antrean pesan grup (dikumpulkan selama 60 detik)
// Format: groupJid => Array<MessageObject>
const messageQueue = new Map();

// Flag untuk menandai apakah ada proses moderasi yang sedang berjalan
let isProcessing = false;

// Waktu tunda jika terkena limit kuota 429
let rateLimitCooldownUntil = 0;

/**
 * System Instruction untuk Moderasi Pesan Grup WhatsApp
 */
const MODERATION_SYSTEM_INSTRUCTION = `Anda adalah asisten moderasi konten cerdas dan objektif untuk grup WhatsApp.
Tugas Anda adalah menganalisis kumpulan pesan grup dan mendeteksi apakah ada pelanggaran aturan komunitas.

Kategori Pelanggaran:
1. TOXICITY: Makian kasar, hinaan personal yang merendahkan, intimidasi, pelecehan verbal.
2. HATE_SPEECH: Ujaran kebencian, diskriminasi berdasarkan SARA (Suku, Agama, Ras, Antargolongan).
3. PENIPUAN_SCAM: Penipuan finansial, tautan phishing, pinjol ilegal, atau promosi judi online/slot.
4. KONTEN_DEWASA: Konten pornografi, ajakan seksual vulgar, pelecehan asusila.
5. PROVOKASI_KEKERASAN: Ajakan tawuran, ancaman kekerasan fisik, teror, ajakan melanggar hukum.
6. AMAN: Percakapan santai, diskusi tugas/kerja, sapaan wajar, dan obrolan normal sehari-hari.

Aturan Penting:
- Pahami konteks dari "5 pesan sebelumnya" sebelum menilai pesan saat ini agar tidak salah tafsir.
- Bedakan gaya bahasa gaul/akrab dengan kebencian atau permusuhan yang sesungguhnya.
- Tentukan tingkat keparahan ("ringan", "sedang", atau "berat").
  Pelanggaran HATE_SPEECH, PROVOKASI_KEKERASAN, KONTEN_DEWASA, dan PENIPUAN_SCAM umumnya bertingkat "berat" dan perlu_review = true.
- Wajib mengembalikan respon dalam format JSON ARRAY (application/json), satu objek per pesan:
[
  {
    "message_id": "<ID pesan yang dianalisis>",
    "kategori": "<TOXICITY | HATE_SPEECH | PENIPUAN_SCAM | KONTEN_DEWASA | PROVOKASI_KEKERASAN | AMAN>",
    "tingkat": "<ringan | sedang | berat>",
    "perlu_review": true/false,
    "terindikasi_pelanggaran": true/false,
    "detail": "<Alasan singkat dan jelas mengapa pesan masuk kategori tersebut>"
  }
]`;

/**
 * Cek apakah pesan merupakan basa-basi umum / filler kata singkat
 * seperti 'wkwk', 'oke', 'iya', 'siap', dll.
 */
function isFillerOrShort(text) {
    if (!text || typeof text !== 'string') return true;

    // Bersihkan tanda baca dan spasi
    const clean = text.toLowerCase().replace(/[^a-z0-9]/g, '').trim();

    // 1. Di bawah 4 karakter -> LEWATI
    if (clean.length < 4) return true;

    // 2. Variasi tawa (wkwkwk, hahaha, hehehe, xixixi)
    if (/^(wk)+w*k*$/i.test(clean) ||
        /^(ha)+h*a*$/i.test(clean) ||
        /^(he)+h*e*$/i.test(clean) ||
        /^(xi)+x*i*$/i.test(clean)) {
        return true;
    }

    // 3. Variasi kata basa-basi umum
    const fillerPatterns = [
        /^o+k+e+(y|deh)?$/i,
        /^i+y+a+h?$/i,
        /^y+o+i+$/i,
        /^s+i+a+p+$/i,
        /^s+i+p+$/i,
        /^m+a+n+t+a+p+$/i,
        /^m+a+k+a+s+i+h+$/i,
        /^t+e+r+i+m+a+k+a+s+i+h+$/i,
        /^t+h+a+n+k+s*$/i,
        /^b+e+t+u+l+$/i,
        /^b+e+n+e+r+$/i,
        /^g+a+p+a+p+a+$/i,
        /^g+p+p+$/i,
        /^y+a+u+d+a+h+$/i
    ];

    return fillerPatterns.some(pattern => pattern.test(clean));
}

/**
 * Masukkan pesan ke dalam antrean moderasi batch
 * @param {Object} msgData
 */
function queueMessageForAI(msgData) {
    if (!ai) return;

    const { groupJid, messageType, messageContent } = msgData;

    // 1. Lewati jika pesan adalah STIKER
    if (messageType === 'stiker') {
        return;
    }

    // 2. Lewati jika pesan adalah MEDIA (gambar, video, audio, VN, dokumen)
    const mediaTypes = ['gambar', 'VN', 'audio', 'video', 'dokumen'];
    if (mediaTypes.includes(messageType)) {
        return;
    }

    // 3. Lewati jika pesan di bawah 4 karakter atau hanya filler/basa-basi (wkwk, oke, iya)
    if (isFillerOrShort(messageContent)) {
        return;
    }

    if (!messageQueue.has(groupJid)) {
        messageQueue.set(groupJid, []);
    }

    messageQueue.get(groupJid).push(msgData);
}

/**
 * Proses antrean pesan tiap 60 detik secara batch
 */
async function processBatchQueue() {
    if (!ai || isProcessing) return;

    // Jika sedang dalam masa jeda rate limit (error 429), tunda eksekusi
    const now = Date.now();
    if (now < rateLimitCooldownUntil) {
        console.log(`⏳ [Gemini AI] Menunggu pendinginan kuota 429... (${Math.ceil((rateLimitCooldownUntil - now) / 1000)} detik tersisa)`);
        return;
    }

    // Cek apakah ada pesan dalam antrean
    let hasMessages = false;
    for (const messages of messageQueue.values()) {
        if (messages.length > 0) {
            hasMessages = true;
            break;
        }
    }
    if (!hasMessages) return;

    isProcessing = true;

    try {
        for (const [groupJid, messages] of messageQueue.entries()) {
            if (messages.length === 0) continue;

            // Ambil maksimal 20 pesan sekaligus per grup untuk satu batch 60 detik
            const currentBatch = messages.splice(0, 20);

            // Ambil 5 pesan sebelumnya dari database sebagai konteks
            const contextMessages = getPreviousGroupMessages(groupJid, 5);

            const groupName = currentBatch[0]?.groupName || 'Grup WhatsApp';

            // Susun input prompt terstruktur untuk Gemini
            const promptPayload = {
                grup: {
                    id: groupJid,
                    nama: groupName
                },
                konteks_percakapan_sebelumnya: contextMessages.map(m => ({
                    waktu: m.timestamp,
                    pengirim: m.sender_name || m.sender_number,
                    isi_pesan: m.message_content
                })),
                pesan_yang_harus_diklasifikasikan: currentBatch.map(m => ({
                    message_id: m.messageId,
                    waktu: m.timestamp,
                    pengirim: m.senderName,
                    nomor: m.senderNumber,
                    isi_pesan: m.messageContent
                }))
            };

            try {
                console.log(`🤖 [Gemini AI] Mengirim batch ${currentBatch.length} pesan (Grup: "${groupName}") untuk moderasi...`);

                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: JSON.stringify(promptPayload),
                    config: {
                        systemInstruction: MODERATION_SYSTEM_INSTRUCTION,
                        responseMimeType: 'application/json'
                    }
                });

                const rawJson = response.text;
                let results = [];
                try {
                    results = JSON.parse(rawJson);
                } catch (parseErr) {
                    console.error('⚠️ Gagal parse respons JSON dari Gemini:', parseErr.message);
                    continue;
                }

                if (!Array.isArray(results)) {
                    results = [results];
                }

                // Proses hasil klasifikasi
                for (const item of results) {
                    if (!item || !item.message_id) continue;

                    let originalMsg = currentBatch.find(m => 
                        m.messageId === item.message_id || 
                        String(m.messageId).trim() === String(item.message_id).trim()
                    );

                    let fallbackMsg = null;
                    if (!originalMsg && item.message_id) {
                        fallbackMsg = getMessageById(item.message_id);
                    }

                    if (!originalMsg && !fallbackMsg) {
                        console.warn(`⚠️ [Gemini AI] Pesan dengan ID ${item.message_id} tidak ditemukan di batch maupun database.`);
                        continue;
                    }

                    const senderNumber = originalMsg?.senderNumber || fallbackMsg?.sender_number || '-';
                    const senderName = originalMsg?.senderName || fallbackMsg?.sender_name || 'Tanpa Nama';
                    const timestamp = originalMsg?.timestamp || fallbackMsg?.timestamp || new Date().toISOString();
                    const messageContent = originalMsg?.messageContent || fallbackMsg?.message_content || '';
                    const groupSubject = originalMsg?.groupName || fallbackMsg?.group_name || groupName;

                    const tingkat = (item.tingkat || 'sedang').toLowerCase();
                    const perluReview = Boolean(item.perlu_review) || tingkat === 'berat';

                    // Jika terdeteksi pelanggaran (bukan kategori AMAN)
                    if (item.terindikasi_pelanggaran || (item.kategori && item.kategori !== 'AMAN')) {
                        saveTemuan({
                            messageId: item.message_id,
                            timestamp: timestamp,
                            groupJid: groupJid,
                            groupName: groupSubject,
                            senderNumber: senderNumber,
                            senderName: senderName,
                            kategori: item.kategori || 'AI_FLAGGED',
                            tingkat: tingkat,
                            perluReview: perluReview,
                            detail: item.detail || 'Terindikasi pelanggaran konten oleh AI',
                            nilai: item.kategori || 'PELANGGARAN',
                            isiPesan: messageContent
                        });

                        console.log(`🚨 [TEMUAN AI: ${item.kategori} | ${tingkat.toUpperCase()}] [${groupSubject}] Dari ${senderName} (${senderNumber}): ${item.detail}`);

                        // Notifikasi ke grup admin untuk SEMUA tingkat >= NOTIF_GRUP_MIN_TINGKAT
                        notifyAdminIfImportant({
                            groupName: groupSubject,
                            groupJid: groupJid,
                            senderName: senderName,
                            senderNumber: senderNumber,
                            kategori: item.kategori || 'AI_FLAGGED',
                            tingkat: tingkat,
                            perluReview: perluReview,
                            detail: item.detail || 'Terindikasi pelanggaran oleh AI',
                            nilai: item.kategori || 'PELANGGARAN',
                            isiPesan: messageContent,
                            timestamp: timestamp,
                            sourceType: 'ai'  // Temuan dari Gemini AI
                        });
                    }
                }

            } catch (apiErr) {
                const errStr = (apiErr.message || '') + (apiErr.status || '');
                const is429 = errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota');

                if (is429) {
                    // Penanganan error 429: Batas kuota tercapai, beri jeda 60 detik
                    rateLimitCooldownUntil = Date.now() + 60000;
                    console.warn(`⚠️ [Gemini 429 Quota Exceeded] Batas kuota tercapai. Menunda antrean grup "${groupName}" dan mencoba kembali dalam 60 detik...`);

                    // Kembalikan pesan yang belum diproses ke depan antrean agar tidak hilang
                    messageQueue.get(groupJid).unshift(...currentBatch);
                    break;
                } else {
                    console.error('❌ Terjadi kesalahan pada panggilan Gemini API:', apiErr.message);
                }
            }
        }
    } catch (generalErr) {
        console.error('❌ Kesalahan umum pada proses antrean moderasi:', generalErr.message);
    } finally {
        isProcessing = false;
    }
}

// Jalankan pengecekan antrean tiap 60 detik (1 menit)
const batchTimer = setInterval(processBatchQueue, 60000);
if (batchTimer.unref) {
    batchTimer.unref();
}

module.exports = {
    queueMessageForAI,
    processBatchQueue,
    isFillerOrShort
};
