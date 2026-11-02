require('dotenv').config();
const cron = require('node-cron');
const { 
    getDailyRecapPerGrup, 
    getDailyRecapPerPelanggar, 
    getDailyPerluReview, 
    getRepeatOffenders, 
    deleteOldMessages 
} = require('./database');
const { getJakartaRecapRange } = require('./timeHelper');
const { getAdminJid, maskSensitiveText, formatIsiPesan } = require('./adminNotifier');

// Socket WhatsApp terkini — diperbarui setiap reconnect via updateCronSocket()
let currentSock = null;

// Flag agar cron hanya terdaftar SATU KALI meskipun koneksi reconnect berkali-kali
let cronRegistered = false;

/**
 * Jalankan proses rekapitulasi harian 24 jam (jam 23.00 kemarin s/d 23.00 hari ini)
 * @param {Date} [refDate] - Tanggal acuan (default waktu saat ini)
 * Gunakan currentSock (module-level) agar selalu pakai socket terbaru.
 */
async function executeDailyRecap(refDate = new Date()) {
    const adminJid = getAdminJid();
    if (!adminJid) {
        console.warn('⚠️ [REKAP HARIAN] ADMIN_NUMBER belum diisi di file .env. Rekap tidak dapat dikirim.');
        return;
    }
    if (!currentSock) {
        console.warn('⚠️ [REKAP HARIAN] Socket WhatsApp belum siap.');
        return;
    }
    const sock = currentSock;

    const { startTime, endTime, sevenDaysAgo, thirtyDaysAgo } = getJakartaRecapRange(refDate);

    console.log('\n' + '='.repeat(70));
    console.log(`⏰ [CRON 23:00 WIB] Menjalankan Rekap Harian 24 Jam...`);
    console.log(`   Rentang: ${startTime} s/d ${endTime} (Asia/Jakarta)`);
    console.log('='.repeat(70));

    // 1. Penghapusan otomatis pesan lama yang berumur lebih dari 30 hari
    const deletedCount = deleteOldMessages(thirtyDaysAgo);
    console.log(`🧹 [RETENSI DATA] Berhasil membersihkan ${deletedCount} pesan yang berumur > 30 hari.`);

    // 2. Ambil data dari database SQLite
    const rekapGrup = getDailyRecapPerGrup(startTime, endTime);
    const rekapPelanggar = getDailyRecapPerPelanggar(startTime, endTime);
    const kasusReview = getDailyPerluReview(startTime, endTime);
    const repeatOffenders = getRepeatOffenders(sevenDaysAgo);

    // Helper untuk mengirim pesan bertahap dengan jeda 1.5 detik agar urutan rapi
    async function sendMsgToAdmin(text) {
        try {
            // Pecah jika melebihi batas aman pesan WhatsApp
            if (text.length > 3500) {
                const parts = [];
                let current = text;
                while (current.length > 3500) {
                    let splitIdx = current.lastIndexOf('\n', 3500);
                    if (splitIdx === -1) splitIdx = 3500;
                    parts.push(current.slice(0, splitIdx));
                    current = current.slice(splitIdx).trimStart();
                }
                if (current.length > 0) parts.push(current);

                for (const part of parts) {
                    await sock.sendMessage(adminJid, { text: part });
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
            } else {
                await sock.sendMessage(adminJid, { text });
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        } catch (err) {
            console.error('❌ Gagal mengirim pesan rekap ke admin:', err.message);
        }
    }

    // ========================================================
    // PESAN 1: RINGKASAN UTAMA HARIAN & PELANGGAR BERULANG
    // ========================================================
    const totalSemuaPelanggaran = rekapGrup.reduce((acc, g) => acc + g.total_pelanggaran, 0);

    let headerMsg = `📊 *REKAP HARIAN PELANGGARAN WHATSAPP*\n`;
    headerMsg += `⏰ *Periode (24 Jam WIB):*\n`;
    headerMsg += `_${startTime}_ s/d _${endTime}_\n`;
    headerMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    headerMsg += `📈 *RINGKASAN EKSEKUTIF:*\n`;
    headerMsg += `• Total Pelanggaran 24 Jam : *${totalSemuaPelanggaran} kejadian*\n`;
    headerMsg += `• Grup Terindikasi         : *${rekapGrup.length} grup*\n`;
    headerMsg += `• Kasus Perlu Review       : *${kasusReview.length} kasus*\n`;
    headerMsg += `• Pembersihan Pesan >30hr  : *${deletedCount} pesan dihapus*\n\n`;

    // Bagian 4: Pelanggar berulang (≥ 3 kali dalam 7 hari terakhir)
    headerMsg += `⚠️ *PELANGGAR BERULANG (≥ 3x dalam 7 hari terakhir):*\n`;
    if (repeatOffenders.length === 0) {
        headerMsg += `_Tidak ada anggota yang melanggar ≥ 3 kali dalam 7 hari terakhir._\n\n`;
    } else {
        repeatOffenders.forEach((p, idx) => {
            headerMsg += `${idx + 1}. *${p.sender_name}* (+${p.sender_number})\n`;
            headerMsg += `   • Total Pelanggaran : *${p.total_pelanggaran} kali*\n`;
            headerMsg += `   • Jenis Pelanggaran : ${p.daftar_kategori}\n`;
            headerMsg += `   • Tersebar di Grup  : ${p.daftar_grup}\n`;
        });
        headerMsg += `\n`;
    }

    // Bagian 1: Total pelanggaran per grup (ringkasan cepat)
    headerMsg += `📋 *TOTAL PELANGGARAN PER GRUP (24 JAM):*\n`;
    if (rekapGrup.length === 0) {
        headerMsg += `_Nihil. Tidak ada pelanggaran di grup mana pun selama 24 jam terakhir._\n`;
    } else {
        rekapGrup.forEach((g, idx) => {
            headerMsg += `${idx + 1}. *${g.nama_grup}*: ${g.total_pelanggaran} temuan\n`;
        });
    }

    headerMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (rekapGrup.length > 0) {
        headerMsg += `_Rincian per grup akan dikirimkan di bawah ini._`;
    }

    await sendMsgToAdmin(headerMsg);

    // Jika tidak ada pelanggaran, selesai
    if (rekapGrup.length === 0) {
        console.log('✅ Rekap selesai dikirim (tidak ada pelanggaran dalam 24 jam terakhir).');
        return;
    }

    // ========================================================
    // PESAN 2..N: RINCIAN PER GRUP (DIPECAH PER GRUP AGAR TIDAK BANJIR/PANJANG)
    // ========================================================
    for (const grup of rekapGrup) {
        let groupMsg = `📌 *RINCIAN REKAP GRUP*\n`;
        groupMsg += `🏷️ *Nama Grup:* ${grup.nama_grup}\n`;
        groupMsg += `🆔 *ID Grup:* \`${grup.id_grup}\`\n`;
        groupMsg += `📊 *Total Pelanggaran:* ${grup.total_pelanggaran} kejadian\n`;
        groupMsg += `─────────────────────────────\n\n`;

        // Bagian 2 & 5: Jumlah pelanggaran per orang, per kategori (Nama akun & nomor)
        const pelanggarDiGrup = rekapPelanggar.filter(p => p.group_jid === grup.id_grup);
        groupMsg += `👤 *DAFTAR PELANGGAR & KATEGORI:*\n`;
        if (pelanggarDiGrup.length === 0) {
            groupMsg += `_Tidak ada rincian._\n\n`;
        } else {
            // Kelompokkan per nomor pengirim
            const sendersMap = new Map();
            for (const p of pelanggarDiGrup) {
                if (!sendersMap.has(p.sender_number)) {
                    sendersMap.set(p.sender_number, {
                        name: p.sender_name,
                        categories: []
                    });
                }
                sendersMap.get(p.sender_number).categories.push(`${p.kategori} (${p.jumlah}x)`);
            }

            let sIdx = 1;
            for (const [nomor, info] of sendersMap.entries()) {
                groupMsg += `${sIdx++}. *${info.name}* (+${nomor})\n`;
                groupMsg += `   └ Pelanggaran: ${info.categories.join(', ')}\n`;
            }
            groupMsg += `\n`;
        }

        // Bagian 3: Kasus "perlu_review" yang belum diputuskan di grup ini
        const reviewDiGrup = kasusReview.filter(r => r.group_jid === grup.id_grup);
        groupMsg += `🔍 *KASUS PERLU REVIEW (${reviewDiGrup.length}):*\n`;
        if (reviewDiGrup.length === 0) {
            groupMsg += `_Tidak ada kasus perlu review di grup ini._\n`;
        } else {
            reviewDiGrup.forEach((rev, rIdx) => {
                const rawPesan = rev.isi_pesan || '-';
                const maskedPesan = maskSensitiveText(rawPesan, rev.kategori, rev.nilai);
                const kutipan = formatIsiPesan(maskedPesan, 300) || '-';

                groupMsg += `• *#${rIdx + 1}* [${rev.kategori} | ${(rev.tingkat || 'berat').toUpperCase()}]\n`;
                groupMsg += `  Oleh: ${rev.sender_name} (+${rev.sender_number})\n`;
                groupMsg += `  Alasan: ${rev.detail}\n`;
                groupMsg += `  Kutipan: "${kutipan}"\n`;
                groupMsg += `  Waktu: ${rev.timestamp}\n`;
            });
        }

        groupMsg += `─────────────────────────────`;

        // Kirim rincian per grup
        await sendMsgToAdmin(groupMsg);
    }

    console.log(`✅ [CRON 23:00 WIB] Seluruh rekap harian berhasil dikirim ke Admin (${adminJid}).`);
}

/**
 * Perbarui socket yang dipakai oleh cron (dipanggil setiap kali koneksi 'open').
 * Cron hanya didaftarkan SATU KALI; socket diperbarui tanpa mendaftar ulang.
 * @param {Object} sock - Instance Baileys terbaru
 */
function initCronScheduler(sock) {
    // Selalu perbarui referensi socket ke yang terbaru
    currentSock = sock;

    // Daftarkan cron HANYA jika belum pernah didaftarkan
    if (cronRegistered) {
        console.log('🔄 [CRON] Socket diperbarui (reconnect). Jadwal rekap harian tetap aktif.');
        return;
    }

    // Jadwal: Setiap hari pada menit 0, jam 23 (23:00 WIB)
    cron.schedule('0 23 * * *', async () => {
        try {
            await executeDailyRecap();
        } catch (err) {
            console.error('❌ Error saat mengeksekusi cron rekap harian:', err.message);
        }
    }, {
        scheduled: true,
        timezone: 'Asia/Jakarta'
    });

    cronRegistered = true;
    console.log('⏰ Penjadwal otomatis aktif: Rekap harian dikirim setiap hari jam 23.00 WIB (Asia/Jakarta) ke chat pribadi admin.');
}

module.exports = {
    initCronScheduler,
    executeDailyRecap
};
