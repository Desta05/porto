const { getRecentMessages, getRecentTemuan } = require('./database');

console.log('\n' + '='.repeat(80));
console.log('📊 [1] DAFTAR PESAN GRUP TERAKHIR DI DATABASE (messages.db -> group_messages)');
console.log('='.repeat(80));

const messages = getRecentMessages(15);
if (messages.length === 0) {
    console.log('Belum ada pesan grup yang tercatat.');
} else {
    console.table(messages);
}

console.log('\n' + '='.repeat(80));
console.log('🚨 [2] DAFTAR TEMUAN PELANGGARAN TERAKHIR (messages.db -> temuan)');
console.log('='.repeat(80));

const temuan = getRecentTemuan(20);
if (temuan.length === 0) {
    console.log('Belum ada temuan spam, data sensitif, atau pelanggaran AI yang tercatat.');
} else {
    console.table(temuan);
}

console.log('='.repeat(80));
console.log('💡 Tip: Jalankan "npm run rekap" untuk melihat total jumlah pelanggaran per grup.');
console.log('='.repeat(80) + '\n');
