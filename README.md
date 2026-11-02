# 🤖 WhatsApp Group Security & AI Moderation Bot

Bot WhatsApp otomatis berbasis **Node.js**, **Baileys**, **Google Gemini AI**, dan **SQLite** yang dirancang untuk mengawasi seluruh grup WhatsApp secara pasif (*zero disruption*), mendeteksi pelanggaran keamanan & kebocoran data sensitif secara instan, melakukan moderasi konten berbasis kecerdasan buatan, serta mengirimkan notifikasi realtime dan rekapitulasi harian ke Admin.

---

## ✨ Fitur Utama

### 🧠 1. Moderasi Konten Cerdas (Google Gemini AI)
- **Analisis Kontekstual**: Memproses percakapan secara batch tiap 60 detik dengan membaca 5 pesan sebelumnya sebagai konteks agar penilaian akurat.
- **Kategori Deteksi**:
  - `TOXICITY`: Makian kasar, hinaan personal yang merendahkan, pelecehan verbal.
  - `HATE_SPEECH`: Ujaran kebencian atau diskriminasi SARA.
  - `PENIPUAN_SCAM`: Penipuan finansial, link phishing, pinjol ilegal, atau promosi judi online/slot.
  - `KONTEN_DEWASA`: Konten pornografi, ajakan seksual vulgar, asusila.
  - `PROVOKASI_KEKERASAN`: Ajakan tawuran, teror, ancaman kekerasan fisik.
- **Filter Otomatis**: Mengabaikan pesan filler / basa-basi singkat (`wkwk`, `oke`, `siap`, dll.) untuk efisiensi kuota token AI.
- **Auto Cooldown 429**: Penanganan otomatis jika kuota API mencapai batas (*Rate Limit*).

### ⚡ 2. Deteksi Spam Realtime (Sliding Window di Memori)
- **Teks Berulang**: Mendeteksi pengirim yang mengirim teks identik (setelah normalisasi lowercase, trim, spasi ganda) sebanyak $\ge 3$ kali dalam 10 detik. Pesan singkat seperti `"P"` tetap dihitung.
- **Stiker Beruntun**: Mendeteksi pengirim yang membanjiri $\ge 5$ stiker dalam 10 detik.
- **Anti-Flood Cooldown**: Cooldown 60 detik per pengirim per tipe spam agar notifikasi tidak membajiri grup admin.

### 🔒 3. Deteksi Kebocoran Data Sensitif & Doxxing
- **NIK KTP**: Deteksi pola 16 digit angka kependudukan Indonesia.
- **Nomor HP Indonesia**: Deteksi nomor HP format lokal (+62, 62, 08).
- **Alamat Tempat Tinggal**: Deteksi pola alamat geografis (Jalan, Gang, RT/RW, Blok, No. Rumah).
- **Penyamaran Nilai Sensitif (Masking)**: Data sensitif otomatis disamarkan di pesan notifikasi grup & rekap DM (`3171************`, `0812****7890`, `[alamat disamarkan]`), sementara data asli tetap tersimpan aman di database SQLite.

### 📢 4. Notifikasi Realtime ke Grup Admin Operasional
- Format pesan rapi menyertakan kutipan pesan pelanggar (maksimal 300 karakter), jam kejadian (WIB), nama pengirim, dan alasan temuan.
- Menggabungkan temuan (*debounce* 2 menit) dengan batas maksimal 20 notifikasi per jam.
- Pemecahan pesan otomatis (*chunking*) jika total teks melebihi batas karakter WhatsApp.
- **Prinsip Pasif**: Bot **TIDAK PERNAH** merespon di grup anggota, tidak menghapus pesan, dan tidak mengeluarkan anggota. Bot hanya melapor ke grup Admin Operasional.

### 📊 5. Rekapitulasi Harian Otomatis (Cron 23:00 WIB)
- Dikirim otomatis setiap pukul 23:00 WIB langsung ke **chat pribadi (DM) WhatsApp Admin**.
- Berisi statistik 24 jam terakhir: total pelanggaran per grup, daftar pelanggar, pelanggar berulang ($\ge 3$ kali dalam 7 hari terakhir), dan kasus yang butuh review lengkap dengan kutipan tersamar.
- **Retensi Data Otomatis**: Pesan riwayat yang berumur lebih dari 30 hari otomatis dibersihkan dari database.

---

## 📁 Struktur Direktori

```text
├── adminNotifier.js    # Notifikasi realtime ke grup admin & format pesan tersamar
├── cleanup-grup.js     # Utilitas pembersihan grup yang sudah tidak aktif
├── config.js           # Pengaturan ID grup pengecualian & batas spam
├── cronScheduler.js    # Penjadwal cron jam 23:00 WIB untuk rekap harian ke DM admin
├── daily-rekap.js      # Skrip eksekusi rekap harian secara manual
├── database.js         # Pengelola SQLite (mode WAL) & migrasi tabel
├── detector.js         # Deteksi spam sliding window & regex data sensitif
├── geminiModerator.js  # Antrean & integrasi Google Gemini AI
├── index.js            # Entry point utama bot WhatsApp (Baileys socket)
├── list-grup.js        # Utilitas melihat & menyalin ID seluruh grup
├── rekap.js            # Skrip ringkasan pelanggaran di terminal
├── timeHelper.js       # Helper konversi waktu Asia/Jakarta (WIB)
├── view-db.js          # Utilitas inspeksi isi database SQLite
├── .env.example        # Template variabel lingkungan
└── package.json        # Dependensi & skrip npm
```

---

## 🛠️ Prasyarat

Sebelum memulai, pastikan perangkat Anda telah terpasang:
1. **Node.js** versi 18 atau lebih baru ([Unduh Node.js](https://nodejs.org/)).
2. **Git** ([Unduh Git](https://git-scm.com/)).
3. **Google Gemini API Key** (Dapatkan gratis di [Google AI Studio](https://aistudio.google.com/)).
4. Akun WhatsApp aktif di HP untuk menautkan perangkat bot.

---

## 🚀 Panduan Instalasi & Penggunaan

### 1. Klon Repositori
```bash
git clone https://github.com/Desta05/porto.git
cd porto
```

### 2. Pasang Dependensi
```bash
npm install
```

### 3. Konfigurasi Variabel Lingkungan (`.env`)
Salin file template `.env.example` menjadi `.env`:

**Windows (PowerShell / Command Prompt):**
```cmd
copy .env.example .env
```
**Linux / macOS:**
```bash
cp .env.example .env
```

Buka file `.env` dan sesuaikan nilainya:
```env
# API Key dari Google AI Studio
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash-lite

# Nomor WhatsApp Admin untuk menerima Rekap Harian jam 23:00 WIB (format 08xxx atau 628xxx)
ADMIN_NUMBER=081234567890
```

### 4. Konfigurasi Grup di `config.js`
Buka file `config.js`:
- `GRUP_REKAP_ID`: Masukkan ID Grup WhatsApp Admin yang ditugaskan menerima notifikasi realtime (format `xxxxxxxxxx@g.us`).
- `excludedGroups`: Pastikan ID grup admin tersebut juga dimasukkan ke dalam daftar ini agar percakapan internal admin tidak dipantau atau disimpan bot.
- `NOTIF_GRUP_MIN_TINGKAT`: Tingkat minimum temuan yang diteruskan (`'ringan'`, `'sedang'`, atau `'berat'`).

> 💡 **Tips:** Untuk mengetahui ID grup WhatsApp Anda, jalankan perintah `npm run list-grup` setelah bot berhasil login sekali.

### 5. Jalankan Bot
```bash
npm start
```

1. Terminal akan menampilkan **QR Code**.
2. Buka aplikasi WhatsApp di HP Anda.
3. Masuk ke **Menu (titik tiga) > Perangkat Tertaut > Tautkan Perangkat**.
4. Pindai QR Code di terminal.
5. Bot siap memantau grup secara otomatis! 🎉

---

## 💻 Daftar Perintah Terminal

| Perintah | Deskripsi |
| :--- | :--- |
| `npm start` | Menjalankan bot WhatsApp utama |
| `npm run list-grup` | Menampilkan seluruh ID grup yang diikuti bot |
| `npm run rekap` | Melihat tabel ringkasan pelanggaran per grup di terminal |
| `npm run daily-rekap` | Mengirimkan laporan rekap 24 jam secara manual ke WhatsApp Admin |
| `npm run view` | Melihat daftar pesan dan temuan terbaru dari database SQLite |
| `npm run cleanup` | Membersihkan data grup yang sudah tidak diikuti bot |

---

## 🛡️ Keamanan & Privasi

- **Tidak Ada Hardcoded Secrets**: Seluruh kredensial sesi WhatsApp disimpan lokal di folder `session/` dan variabel rahasia di `.env`, yang keduanya telah diabaikan dalam `.gitignore`.
- **Database Lokal**: Pesan dan data temuan disimpan di file SQLite lokal (`messages.db`), tidak dikirim ke server pihak ketiga manapun selain teks pelanggaran ke Google Gemini untuk kebutuhan klasifikasi.
- **Data Sensitif Terlindungi**: NIK, No HP, dan Alamat tempat tinggal disamarkan sebelum ditampilkan pada notifikasi pesan WhatsApp.

---

## 👤 Pembuat & Lisensi

Dibuat oleh **[Desta Mufrianto](https://github.com/Desta05)**.  
Didistribusikan di bawah lisensi **MIT**. Bebas digunakan, dimodifikasi, dan dikembangkan kembali untuk komunitas.
