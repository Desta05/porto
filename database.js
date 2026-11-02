const Database = require('better-sqlite3');
const path = require('path');

// Inisialisasi database SQLite (file akan otomatis dibuat jika belum ada)
const dbPath = path.join(__dirname, 'messages.db');
const db = new Database(dbPath);

// Aktifkan mode WAL (Write-Ahead Logging) untuk performa baca/tulis yang optimal
db.pragma('journal_mode = WAL');

// Buat tabel jika belum ada & migrasi kolom tambahan
function initDatabase() {
    const createTableQuery = `
        -- Tabel untuk mencatat seluruh pesan grup
        CREATE TABLE IF NOT EXISTS group_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT UNIQUE,
            timestamp TEXT NOT NULL,
            group_jid TEXT NOT NULL,
            group_name TEXT,
            sender_number TEXT NOT NULL,
            sender_name TEXT,
            message_type TEXT NOT NULL,
            message_content TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_group ON group_messages(group_jid);
        CREATE INDEX IF NOT EXISTS idx_timestamp ON group_messages(timestamp);

        -- Tabel untuk mencatat temuan (Spam, NIK, Nomor HP, Alamat, AI Gemini)
        CREATE TABLE IF NOT EXISTS temuan (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT,
            timestamp TEXT NOT NULL,
            group_jid TEXT NOT NULL,
            group_name TEXT,
            sender_number TEXT NOT NULL,
            sender_name TEXT,
            kategori TEXT NOT NULL,       -- 'SPAM', 'NIK', 'NOMOR_HP', 'ALAMAT', atau Kategori AI
            tingkat TEXT DEFAULT 'sedang', -- 'ringan', 'sedang', 'berat'
            perlu_review INTEGER DEFAULT 0, -- 1 jika perlu review, 0 jika tidak
            detail TEXT NOT NULL,         -- Keterangan temuan
            nilai TEXT,                   -- Nilai data yang terdeteksi
            isi_pesan TEXT,               -- Teks pesan asli
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_temuan_kategori ON temuan(kategori);
        CREATE INDEX IF NOT EXISTS idx_temuan_group ON temuan(group_jid);
        CREATE INDEX IF NOT EXISTS idx_temuan_sender ON temuan(sender_number);
    `;
    db.exec(createTableQuery);

    // ==========================================
    // MIGRASI: Tambahkan kolom yang belum ada di database lama
    // ==========================================
    try {
        const msgCols = db.pragma('table_info(group_messages)').map(c => c.name);
        if (!msgCols.includes('group_name')) {
            db.exec('ALTER TABLE group_messages ADD COLUMN group_name TEXT');
            console.log('🔄 [MIGRASI] Berhasil menambahkan kolom group_name ke tabel group_messages');
        }

        const temuanCols = db.pragma('table_info(temuan)').map(c => c.name);
        if (!temuanCols.includes('group_name')) {
            db.exec('ALTER TABLE temuan ADD COLUMN group_name TEXT');
            console.log('🔄 [MIGRASI] Berhasil menambahkan kolom group_name ke tabel temuan');
        }
        if (!temuanCols.includes('tingkat')) {
            db.exec("ALTER TABLE temuan ADD COLUMN tingkat TEXT DEFAULT 'sedang'");
            console.log('🔄 [MIGRASI] Berhasil menambahkan kolom tingkat ke tabel temuan');
        }
        if (!temuanCols.includes('perlu_review')) {
            db.exec('ALTER TABLE temuan ADD COLUMN perlu_review INTEGER DEFAULT 0');
            console.log('🔄 [MIGRASI] Berhasil menambahkan kolom perlu_review ke tabel temuan');
        }
    } catch (migErr) {
        console.error('⚠️ Catatan migrasi:', migErr.message);
    }

    console.log('✅ Database SQLite siap: messages.db (tabel: group_messages, temuan)');
}

// Simpan pesan grup ke tabel group_messages
function saveGroupMessage({ messageId, timestamp, groupJid, groupName, senderNumber, senderName, messageType, messageContent }) {
    try {
        const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO group_messages 
            (message_id, timestamp, group_jid, group_name, sender_number, sender_name, message_type, message_content)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = insertStmt.run(
            messageId,
            timestamp,
            groupJid,
            groupName || 'Grup WhatsApp',
            senderNumber,
            senderName || 'Tanpa Nama',
            messageType,
            messageContent || ''
        );

        return result.changes > 0;
    } catch (err) {
        console.error('❌ Gagal menyimpan pesan ke SQLite:', err.message);
        return false;
    }
}

// Simpan data temuan pelanggaran / data sensitif ke tabel temuan
function saveTemuan({ messageId, timestamp, groupJid, groupName, senderNumber, senderName, kategori, tingkat, perluReview, detail, nilai, isiPesan }) {
    try {
        const insertStmt = db.prepare(`
            INSERT INTO temuan 
            (message_id, timestamp, group_jid, group_name, sender_number, sender_name, kategori, tingkat, perlu_review, detail, nilai, isi_pesan)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = insertStmt.run(
            messageId,
            timestamp,
            groupJid,
            groupName || 'Grup WhatsApp',
            senderNumber,
            senderName || 'Tanpa Nama',
            kategori,
            tingkat || 'sedang',
            perluReview ? 1 : 0,
            detail,
            nilai || '',
            isiPesan || ''
        );

        return result.changes > 0;
    } catch (err) {
        console.error('❌ Gagal menyimpan temuan ke SQLite:', err.message);
        return false;
    }
}

// Ambil riwayat pesan grup terbaru
function getRecentMessages(limit = 20) {
    const query = db.prepare(`
        SELECT id, timestamp, group_name, group_jid, sender_name, sender_number, message_type, message_content
        FROM group_messages
        ORDER BY id DESC
        LIMIT ?
    `);
    return query.all(limit);
}

// Ambil riwayat temuan terbaru
function getRecentTemuan(limit = 20) {
    const query = db.prepare(`
        SELECT id, timestamp, group_name, sender_name, sender_number, kategori, tingkat, perlu_review, detail, nilai, group_jid
        FROM temuan
        ORDER BY id DESC
        LIMIT ?
    `);
    return query.all(limit);
}

// Rekap jumlah pelanggaran per grup
function getRekapPelanggaranPerGrup() {
    const query = db.prepare(`
        SELECT 
            COALESCE(group_name, 'Grup Tanpa Nama') AS nama_grup,
            group_jid AS id_grup,
            COUNT(*) AS total_pelanggaran,
            SUM(CASE WHEN tingkat = 'berat' OR perlu_review = 1 THEN 1 ELSE 0 END) AS tingkat_berat_review,
            SUM(CASE WHEN kategori = 'SPAM' THEN 1 ELSE 0 END) AS spam,
            SUM(CASE WHEN kategori = 'NOMOR_HP' THEN 1 ELSE 0 END) AS no_hp,
            SUM(CASE WHEN kategori = 'NIK' THEN 1 ELSE 0 END) AS nik,
            SUM(CASE WHEN kategori = 'ALAMAT' THEN 1 ELSE 0 END) AS alamat,
            SUM(CASE WHEN kategori NOT IN ('SPAM', 'NOMOR_HP', 'NIK', 'ALAMAT') THEN 1 ELSE 0 END) AS ai_gemini,
            MAX(timestamp) AS temuan_terakhir
        FROM temuan
        GROUP BY group_jid
        ORDER BY total_pelanggaran DESC
    `);
    return query.all();
}

// Ambil 5 pesan sebelumnya dari suatu grup sebagai konteks AI
function getPreviousGroupMessages(groupJid, limit = 5) {
    try {
        const query = db.prepare(`
            SELECT sender_name, sender_number, message_type, message_content, timestamp
            FROM group_messages
            WHERE group_jid = ?
            ORDER BY id DESC
            LIMIT ?
        `);
        const rows = query.all(groupJid, limit);
        return rows.reverse(); // Urutkan kronologis dari yang terlama ke terbaru
    } catch (err) {
        console.error('❌ Gagal mengambil pesan konteks:', err.message);
        return [];
    }
}

// 1. Total pelanggaran per grup dalam rentang waktu tertentu
function getDailyRecapPerGrup(startTime, endTime) {
    const query = db.prepare(`
        SELECT 
            COALESCE(group_name, 'Grup Tanpa Nama') AS nama_grup,
            group_jid AS id_grup,
            COUNT(*) AS total_pelanggaran
        FROM temuan
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY group_jid
        ORDER BY total_pelanggaran DESC
    `);
    return query.all(startTime, endTime);
}

// 2. Jumlah pelanggaran per orang, per kategori dalam rentang waktu tertentu
function getDailyRecapPerPelanggar(startTime, endTime) {
    const query = db.prepare(`
        SELECT 
            group_jid,
            COALESCE(group_name, 'Grup Tanpa Nama') AS nama_grup,
            COALESCE(sender_name, 'Tanpa Nama') AS sender_name,
            sender_number,
            kategori,
            COUNT(*) AS jumlah
        FROM temuan
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY group_jid, sender_number, kategori
        ORDER BY group_jid, jumlah DESC
    `);
    return query.all(startTime, endTime);
}

// 3. Daftar kasus "perlu_review" / tingkat berat dalam rentang waktu tertentu
function getDailyPerluReview(startTime, endTime) {
    const query = db.prepare(`
        SELECT 
            id,
            timestamp,
            group_jid,
            COALESCE(group_name, 'Grup Tanpa Nama') AS nama_grup,
            COALESCE(sender_name, 'Tanpa Nama') AS sender_name,
            sender_number,
            kategori,
            tingkat,
            detail,
            nilai,
            isi_pesan
        FROM temuan
        WHERE (perlu_review = 1 OR tingkat = 'berat')
          AND timestamp >= ? AND timestamp <= ?
        ORDER BY id ASC
    `);
    return query.all(startTime, endTime);
}

// 4. Orang yang sudah melanggar 3 kali atau lebih dalam 7 hari terakhir
function getRepeatOffenders(sevenDaysAgo) {
    const query = db.prepare(`
        SELECT 
            sender_number,
            COALESCE(sender_name, 'Tanpa Nama') AS sender_name,
            COUNT(*) AS total_pelanggaran,
            GROUP_CONCAT(DISTINCT COALESCE(group_name, 'Grup')) AS daftar_grup,
            GROUP_CONCAT(DISTINCT kategori) AS daftar_kategori
        FROM temuan
        WHERE timestamp >= ?
        GROUP BY sender_number
        HAVING COUNT(*) >= 3
        ORDER BY total_pelanggaran DESC
    `);
    return query.all(sevenDaysAgo);
}

// 5. Hapus pesan lama yang lebih dari 30 hari dari tabel group_messages
function deleteOldMessages(thirtyDaysAgo) {
    try {
        const stmt = db.prepare(`DELETE FROM group_messages WHERE timestamp < ?`);
        const result = stmt.run(thirtyDaysAgo);
        return result.changes;
    } catch (err) {
        console.error('❌ Gagal menghapus pesan lama:', err.message);
        return 0;
    }
}

// 6. Ambil pesan berdasarkan message_id
function getMessageById(messageId) {
    try {
        if (!messageId) return null;
        const stmt = db.prepare(`SELECT * FROM group_messages WHERE message_id = ? LIMIT 1`);
        return stmt.get(messageId) || null;
    } catch (err) {
        console.error('❌ Gagal mengambil pesan berdasarkan messageId:', err.message);
        return null;
    }
}

// Inisialisasi otomatis tabel saat modul di-require
initDatabase();

module.exports = {
    initDatabase,
    saveGroupMessage,
    saveTemuan,
    getRecentMessages,
    getRecentTemuan,
    getRekapPelanggaranPerGrup,
    getPreviousGroupMessages,
    getDailyRecapPerGrup,
    getDailyRecapPerPelanggar,
    getDailyPerluReview,
    getRepeatOffenders,
    deleteOldMessages,
    getMessageById,
    db
};
