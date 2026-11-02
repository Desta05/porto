/**
 * Konfigurasi Bot WhatsApp
 */
module.exports = {
    // Daftar ID Grup WhatsApp yang DIKECUALIKAN (diabaikan secara total).
    // Pesan dari grup di dalam daftar ini:
    // - TIDAK disimpan ke database
    // - TIDAK dicek spam / doxxing / data sensitif
    // - TIDAK dikirim ke AI Gemini
    //
    // CATATAN: Grup Admin Operasional (GRUP_REKAP_ID) HARUS selalu ada di sini.
    // Bot hanya MENGIRIM notifikasi ke sana, tidak membaca / menyimpan pesannya.
    //
    // Format: 'xxxxxxxxxx@g.us'
    // Tip: Jalankan "npm run list-grup" untuk melihat semua ID grup Anda.
    excludedGroups: [
        '120363431012874615@g.us', // Grup Admin Operasional (hanya menerima notif, bukan dipantau)
    ],

    // ID Grup Admin Operasional yang menerima notifikasi temuan REALTIME.
    // Isi dengan ID yang sama seperti di atas.
    // Kosongkan ('') untuk menonaktifkan notifikasi ke grup.
    GRUP_REKAP_ID: '120363431012874615@g.us',

    // Tingkat minimum temuan yang dikirim ke grup Admin Operasional.
    // Nilai yang valid: 'ringan' | 'sedang' | 'berat'
    // 'ringan' → kirim semua temuan
    // 'sedang' → lewati temuan ringan
    // 'berat'  → hanya kirim temuan berat
    NOTIF_GRUP_MIN_TINGKAT: 'ringan',

    // Pengaturan Ambang Batas SPAM
    SPAM_JENDELA_DETIK: 10,
    SPAM_TEKS_MIN: 3,
    SPAM_STIKER_MIN: 5,
};
