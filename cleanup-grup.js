/**
 * cleanup-grup.js
 * ================
 * Skrip untuk melihat daftar semua grup di database beserta jumlah pesan & temuan,
 * lalu menghapus data (pesan + temuan) dari grup yang dipilih.
 *
 * Cara pakai:
 *   1. Lihat daftar grup  : node cleanup-grup.js
 *   2. Hapus grup tertentu: node cleanup-grup.js --hapus "NamaGrup1" "NamaGrup2"
 *   3. Hapus via ID grup  : node cleanup-grup.js --hapus-id "120363xxx@g.us" "120363yyy@g.us"
 *   4. Hapus SEMUA kecuali: node cleanup-grup.js --kecuali "NamaGrupYangDisimpan1" "NamaGrupYangDisimpan2"
 *   5. Hapus SEMUA kecuali (ID): node cleanup-grup.js --kecuali-id "120363xxx@g.us"
 */

const Database = require('better-sqlite3');
const path = require('path');
const readline = require('readline');

const dbPath = path.join(__dirname, 'messages.db');
const db = new Database(dbPath, { readonly: false });

// ==========================================
// 1. TAMPILKAN DAFTAR GRUP DI DATABASE
// ==========================================
function showGroupList() {
    const query = db.prepare(`
        SELECT 
            gm.group_jid,
            COALESCE(gm.group_name, 'Tanpa Nama') AS group_name,
            gm.jumlah_pesan,
            COALESCE(t.jumlah_temuan, 0) AS jumlah_temuan,
            gm.pesan_pertama,
            gm.pesan_terakhir
        FROM (
            SELECT 
                group_jid,
                MAX(group_name) AS group_name,
                COUNT(*) AS jumlah_pesan,
                MIN(timestamp) AS pesan_pertama,
                MAX(timestamp) AS pesan_terakhir
            FROM group_messages
            GROUP BY group_jid
        ) gm
        LEFT JOIN (
            SELECT group_jid, COUNT(*) AS jumlah_temuan
            FROM temuan
            GROUP BY group_jid
        ) t ON gm.group_jid = t.group_jid
        ORDER BY gm.jumlah_pesan DESC
    `);

    const rows = query.all();

    if (rows.length === 0) {
        console.log('\n📭 Database kosong — belum ada pesan grup yang tercatat.\n');
        return rows;
    }

    console.log('\n' + '='.repeat(120));
    console.log('📊 DAFTAR SEMUA GRUP DI DATABASE (messages.db)');
    console.log('='.repeat(120));

    const totalPesan = rows.reduce((s, r) => s + r.jumlah_pesan, 0);
    const totalTemuan = rows.reduce((s, r) => s + r.jumlah_temuan, 0);

    console.log(`\nTotal: ${rows.length} grup | ${totalPesan} pesan | ${totalTemuan} temuan\n`);

    const tableData = rows.map((r, i) => ({
        'No': i + 1,
        'Nama Grup': r.group_name.length > 35 ? r.group_name.slice(0, 32) + '...' : r.group_name,
        'ID Grup': r.group_jid,
        'Pesan': r.jumlah_pesan,
        'Temuan': r.jumlah_temuan,
        'Pertama': r.pesan_pertama || '-',
        'Terakhir': r.pesan_terakhir || '-'
    }));

    console.table(tableData);
    console.log('='.repeat(120));

    return rows;
}

// ==========================================
// 2. HAPUS DATA GRUP BERDASARKAN group_jid
// ==========================================
function deleteGroupData(groupJids) {
    if (!groupJids || groupJids.length === 0) {
        console.log('\n⚠️ Tidak ada grup yang dipilih untuk dihapus.\n');
        return;
    }

    const deleteMessages = db.prepare('DELETE FROM group_messages WHERE group_jid = ?');
    const deleteTemuan = db.prepare('DELETE FROM temuan WHERE group_jid = ?');

    const deleteAll = db.transaction((jids) => {
        let totalMsg = 0;
        let totalTem = 0;

        for (const jid of jids) {
            const msgResult = deleteMessages.run(jid);
            const temResult = deleteTemuan.run(jid);
            totalMsg += msgResult.changes;
            totalTem += temResult.changes;
            console.log(`   🗑️ ${jid} → ${msgResult.changes} pesan, ${temResult.changes} temuan dihapus`);
        }

        return { totalMsg, totalTem };
    });

    console.log('\n🔄 Menghapus data grup...\n');
    const { totalMsg, totalTem } = deleteAll(groupJids);
    console.log(`\n✅ Selesai! Total dihapus: ${totalMsg} pesan + ${totalTem} temuan dari ${groupJids.length} grup.`);
    console.log('💡 Jalankan "node cleanup-grup.js" lagi untuk memverifikasi.\n');
}

// ==========================================
// 3. KONFIRMASI INTERAKTIF
// ==========================================
function askConfirmation(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

// ==========================================
// MAIN
// ==========================================
async function main() {
    const args = process.argv.slice(2);
    const rows = showGroupList();

    if (rows.length === 0) {
        db.close();
        return;
    }

    // Mode 1: --hapus "NamaGrup1" "NamaGrup2"
    if (args[0] === '--hapus' && args.length > 1) {
        const namaGrup = args.slice(1);
        const matched = rows.filter(r =>
            namaGrup.some(n => r.group_name.toLowerCase().includes(n.toLowerCase()))
        );

        if (matched.length === 0) {
            console.log(`\n⚠️ Tidak ditemukan grup dengan nama yang cocok: ${namaGrup.join(', ')}\n`);
            db.close();
            return;
        }

        console.log(`\n🎯 Grup yang akan DIHAPUS (${matched.length} grup):`);
        matched.forEach((r, i) => console.log(`   ${i + 1}. "${r.group_name}" (${r.jumlah_pesan} pesan, ${r.jumlah_temuan} temuan)`));

        const jawab = await askConfirmation('\n⚠️ Yakin ingin menghapus data grup di atas? (ketik "ya" untuk konfirmasi): ');
        if (jawab === 'ya' || jawab === 'y') {
            deleteGroupData(matched.map(r => r.group_jid));
        } else {
            console.log('\n❌ Dibatalkan.\n');
        }

    // Mode 2: --hapus-id "120363xxx@g.us" "120363yyy@g.us"
    } else if (args[0] === '--hapus-id' && args.length > 1) {
        const jids = args.slice(1);

        console.log(`\n🎯 Grup yang akan DIHAPUS berdasarkan ID (${jids.length} grup):`);
        for (const jid of jids) {
            const found = rows.find(r => r.group_jid === jid);
            if (found) {
                console.log(`   ✓ "${found.group_name}" (${found.jumlah_pesan} pesan, ${found.jumlah_temuan} temuan)`);
            } else {
                console.log(`   ✗ ${jid} — tidak ditemukan di database`);
            }
        }

        const validJids = jids.filter(j => rows.some(r => r.group_jid === j));
        if (validJids.length === 0) {
            console.log('\n⚠️ Tidak ada ID grup yang valid.\n');
            db.close();
            return;
        }

        const jawab = await askConfirmation('\n⚠️ Yakin ingin menghapus data grup di atas? (ketik "ya" untuk konfirmasi): ');
        if (jawab === 'ya' || jawab === 'y') {
            deleteGroupData(validJids);
        } else {
            console.log('\n❌ Dibatalkan.\n');
        }

    // Mode 3: --kecuali "NamaGrupYangDisimpan1" (hapus SEMUA kecuali yang disebutkan)
    } else if (args[0] === '--kecuali' && args.length > 1) {
        const namaKeep = args.slice(1);
        const toKeep = rows.filter(r =>
            namaKeep.some(n => r.group_name.toLowerCase().includes(n.toLowerCase()))
        );
        const toDelete = rows.filter(r => !toKeep.some(k => k.group_jid === r.group_jid));

        console.log(`\n✅ Grup yang DISIMPAN (${toKeep.length}):`);
        toKeep.forEach((r, i) => console.log(`   ${i + 1}. "${r.group_name}" (${r.jumlah_pesan} pesan)`));

        console.log(`\n🗑️ Grup yang akan DIHAPUS (${toDelete.length}):`);
        toDelete.forEach((r, i) => console.log(`   ${i + 1}. "${r.group_name}" (${r.jumlah_pesan} pesan, ${r.jumlah_temuan} temuan)`));

        if (toDelete.length === 0) {
            console.log('\n✅ Tidak ada yang perlu dihapus.\n');
            db.close();
            return;
        }

        const jawab = await askConfirmation('\n⚠️ Yakin ingin menghapus SEMUA grup di atas KECUALI yang disimpan? (ketik "ya"): ');
        if (jawab === 'ya' || jawab === 'y') {
            deleteGroupData(toDelete.map(r => r.group_jid));
        } else {
            console.log('\n❌ Dibatalkan.\n');
        }

    // Mode 4: --kecuali-id "120363xxx@g.us" (hapus SEMUA kecuali ID tertentu)
    } else if (args[0] === '--kecuali-id' && args.length > 1) {
        const keepJids = args.slice(1);
        const toDelete = rows.filter(r => !keepJids.includes(r.group_jid));

        console.log(`\n✅ Grup yang DISIMPAN (${keepJids.length} ID):`);
        keepJids.forEach(jid => {
            const found = rows.find(r => r.group_jid === jid);
            console.log(`   ✓ ${found ? `"${found.group_name}"` : jid}`);
        });

        console.log(`\n🗑️ Grup yang akan DIHAPUS (${toDelete.length}):`);
        toDelete.forEach((r, i) => console.log(`   ${i + 1}. "${r.group_name}" (${r.jumlah_pesan} pesan, ${r.jumlah_temuan} temuan)`));

        if (toDelete.length === 0) {
            console.log('\n✅ Tidak ada yang perlu dihapus.\n');
            db.close();
            return;
        }

        const jawab = await askConfirmation('\n⚠️ Yakin ingin menghapus? (ketik "ya"): ');
        if (jawab === 'ya' || jawab === 'y') {
            deleteGroupData(toDelete.map(r => r.group_jid));
        } else {
            console.log('\n❌ Dibatalkan.\n');
        }

    } else if (args.length > 0 && !['--hapus', '--hapus-id', '--kecuali', '--kecuali-id'].includes(args[0])) {
        console.log('\n📖 Cara pakai:');
        console.log('   node cleanup-grup.js                                    → Lihat daftar grup');
        console.log('   node cleanup-grup.js --hapus "NamaGrup1" "NamaGrup2"    → Hapus berdasarkan nama');
        console.log('   node cleanup-grup.js --hapus-id "xxx@g.us" "yyy@g.us"   → Hapus berdasarkan ID');
        console.log('   node cleanup-grup.js --kecuali "GrupKomunitas"          → Hapus SEMUA kecuali yang disebut');
        console.log('   node cleanup-grup.js --kecuali-id "xxx@g.us"            → Hapus SEMUA kecuali ID tertentu\n');
    } else {
        // Hanya menampilkan daftar (mode default)
        console.log('\n📖 Untuk menghapus, jalankan salah satu:');
        console.log('   node cleanup-grup.js --hapus "NamaGrup"        → Hapus berdasarkan nama grup');
        console.log('   node cleanup-grup.js --hapus-id "xxx@g.us"     → Hapus berdasarkan ID grup');
        console.log('   node cleanup-grup.js --kecuali "GrupSaya"      → Hapus SEMUA kecuali yang disebut');
        console.log('   node cleanup-grup.js --kecuali-id "xxx@g.us"   → Hapus SEMUA kecuali ID tertentu\n');
    }

    db.close();
}

main();
