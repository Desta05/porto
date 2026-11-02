const { getRekapPelanggaranPerGrup } = require('./database');

console.log('\n' + '='.repeat(90));
console.log('📊 REKAPITULASI PELANGGARAN PER GRUP WHATSAPP (Database: messages.db)');
console.log('='.repeat(90));

const data = getRekapPelanggaranPerGrup();

if (data.length === 0) {
    console.log('\nBelum ada pelanggaran yang tercatat di database.');
    console.log('Data pelanggaran (Spam, NIK, No HP, Alamat, atau AI Moderasi) akan muncul di sini.\n');
} else {
    console.log(`\nDitemukan pelanggaran pada ${data.length} grup WhatsApp:\n`);

    const tableData = data.map((item, index) => ({
        'No': index + 1,
        'Nama Grup': item.nama_grup,
        'ID Grup': item.id_grup,
        'Total': item.total_pelanggaran,
        'Berat/Review': item.tingkat_berat_review,
        'Spam': item.spam,
        'No HP': item.no_hp,
        'NIK': item.nik,
        'Alamat': item.alamat,
        'AI Gemini': item.ai_gemini,
        'Terakhir': item.temuan_terakhir
    }));

    console.table(tableData);

    // Hitung total keseluruhan
    const grandTotal = data.reduce((acc, curr) => acc + curr.total_pelanggaran, 0);
    const totalBerat = data.reduce((acc, curr) => acc + curr.tingkat_berat_review, 0);
    const totalSpam = data.reduce((acc, curr) => acc + curr.spam, 0);
    const totalPII = data.reduce((acc, curr) => acc + curr.no_hp + curr.nik + curr.alamat, 0);
    const totalAI = data.reduce((acc, curr) => acc + curr.ai_gemini, 0);

    console.log('='.repeat(90));
    console.log(`📈 RINGKASAN STATISTIK KESELURUHAN:`);
    console.log(`   • Total Pelanggaran Terdeteksi   : ${grandTotal}`);
    console.log(`   • Temuan Berat / Perlu Review    : ${totalBerat} (memicu notifikasi admin)`);
    console.log(`   • Pelanggaran Spam               : ${totalSpam}`);
    console.log(`   • Kebocoran Data (HP/NIK/Alamat) : ${totalPII}`);
    console.log(`   • Pelanggaran Moderasi AI        : ${totalAI}`);
    console.log('='.repeat(90) + '\n');
}
