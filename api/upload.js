# upload.js (FULL REPLACE – SIAP DEPLOY)

```javascript
import multer from "multer";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export const config = {
  api: {
    bodyParser: false
  }
};

// ===============================
// 🔥 MULTER CONFIG
// ===============================
const upload = multer({
  storage: multer.diskStorage({
    destination: "/tmp",
    filename: (req, file, cb) => {
      cb(null, Date.now() + "-" + file.originalname);
    }
  }),
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB
  }
});

// ===============================
// 🔥 HELPER MIDDLEWARE
// ===============================
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

// ===============================
// 🔥 FORMAT RUPIAH
// ===============================
function toNumber(v) {
  return Number(v || 0);
}

// ===============================
// 🔥 MAIN API
// ===============================
export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method tidak diizinkan"
    });
  }

  let uploadedFile = null;
  let extractDir = null;
  let db = null;

  try {

    // ===============================
    // 🔥 UPLOAD FILE
    // ===============================
    await runMiddleware(req, res, upload.single("zipfile"));

    uploadedFile = req.file;

    const storeId = String(req.body.storeId || "")
      .trim()
      .toUpperCase();

    // ===============================
    // 🔥 VALIDASI
    // ===============================
    if (!uploadedFile) {
      return res.status(400).json({
        error: "File ZIP wajib diupload"
      });
    }

    if (!storeId) {
      return res.status(400).json({
        error: "Store ID tidak ditemukan"
      });
    }

    if (!uploadedFile.originalname.toLowerCase().endsWith(".zip")) {
      return res.status(400).json({
        error: "Format file harus ZIP"
      });
    }

    // ===============================
    // 🔥 EXTRACT ZIP
    // ===============================
    extractDir = path.join("/tmp", "extract-" + Date.now());

    fs.mkdirSync(extractDir, {
      recursive: true
    });

    const zip = new AdmZip(uploadedFile.path);
    zip.extractAllTo(extractDir, true);

    // ===============================
    // 🔥 CARI DATABASE
    // ===============================
    const files = fs.readdirSync(extractDir);

    const dbFile = files.find(file => {
      const lower = file.toLowerCase();

      return (
        lower.endsWith(".db") ||
        lower.endsWith(".sqlite") ||
        lower.endsWith(".sqlite3")
      );
    });

    if (!dbFile) {
      return res.status(400).json({
        error: "Database SQLite tidak ditemukan di ZIP"
      });
    }

    const dbPath = path.join(extractDir, dbFile);

    // ===============================
    // 🔥 OPEN DATABASE
    // ===============================
    db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true
    });

    // ===============================
    // 🔥 VALIDASI TABLE
    // ===============================
    const tableCheck = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='table'
      AND name='tx_tsale'
    `).get();

    if (!tableCheck) {
      return res.status(400).json({
        error: "Table tx_tsale tidak ditemukan"
      });
    }

    // ===============================
    // 🔥 VALIDASI STORE
    // ===============================
    const storeCheck = db.prepare(`
      SELECT COUNT(*) as total
      FROM tx_tsale
      WHERE UPPER(store_id)=?
    `).get(storeId);

    if (!storeCheck || storeCheck.total <= 0) {
      return res.status(403).json({
        error: "Data laporan bukan milik toko Anda"
      });
    }

    // ===============================
    // 🔥 AMBIL TANGGAL TERAKHIR
    // ===============================
    const lastDateRow = db.prepare(`
      SELECT MAX(date_tx) as tanggal
      FROM tx_tsale
      WHERE UPPER(store_id)=?
    `).get(storeId);

    if (!lastDateRow || !lastDateRow.tanggal) {
      return res.status(404).json({
        error: "Tanggal transaksi tidak ditemukan"
      });
    }

    const tanggal = lastDateRow.tanggal;

    // ===============================
    // 🔥 HITUNG TOTAL
    // ===============================
    const result = db.prepare(`
      SELECT
        SUM(cash) as total_cash,
        SUM(change_pay) as total_change,
        COUNT(*) as total_transaksi
      FROM tx_tsale
      WHERE UPPER(store_id)=?
      AND date_tx=?
    `).get(storeId, tanggal);

    const cash = toNumber(result?.total_cash);
    const change = toNumber(result?.total_change);
    const hasil = cash - change;

    // ===============================
    // 🔥 DETAIL FILE
    // ===============================
    const namaFile = uploadedFile.originalname.replace(/\.zip$/i, "");

    let detail = `Toko ${storeId}`;

    const splitNama = namaFile.split(/[_-]/);

    if (splitNama.length >= 5) {
      detail = `Toko ${splitNama[0]} | ${splitNama[3]}/${splitNama[2]}/${splitNama[1]} | NIK ${splitNama[4]}`;
    }

    // ===============================
    // 🔥 RESPONSE KE INDEX
    // ===============================
    return res.status(200).json({
      success: true,
      title: "Hasil Laporan Setoran",
      detail,
      tanggal,
      store_id: storeId,
      transaksi: result?.total_transaksi || 0,
      cash,
      change,
      hasil
    });

  } catch (err) {

    console.error("UPLOAD API ERROR:", err);

    return res.status(500).json({
      error: err.message || "Terjadi kesalahan server"
    });

  } finally {

    // ===============================
    // 🔥 CLOSE DB
    // ===============================
    try {
      if (db) {
        db.close();
      }
    } catch (e) {
      console.log("DB CLOSE ERROR:", e.message);
    }

    // ===============================
    // 🔥 HAPUS FILE ZIP
    // ===============================
    try {
      if (uploadedFile?.path && fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }
    } catch (e) {
      console.log("DELETE ZIP ERROR:", e.message);
    }

    // ===============================
    // 🔥 HAPUS FOLDER EXTRACT
    // ===============================
    try {
      if (extractDir && fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, {
          recursive: true,
          force: true
        });
      }
    } catch (e) {
      console.log("DELETE EXTRACT ERROR:", e.message);
    }

  }
}
```

# package.json dependency wajib

```json
{
  "dependencies": {
    "adm-zip": "^0.5.16",
    "better-sqlite3": "^12.4.1",
    "multer": "^2.0.2"
  }
}
```

# Struktur Vercel

```bash
/api/upload.js
/index.html
/package.json
```

# vercel.json (opsional)

```json
{
  "functions": {
    "api/upload.js": {
      "maxDuration": 60
    }
  }
}
```

# Yang sudah disesuaikan dengan index HTML

* API menerima field:

  * zipfile
  * storeId

* Response cocok dengan index:

  * title
  * detail
  * hasil
  * error

* Sudah support:

  * ZIP upload
  * SQLite DB
  * Validasi store
  * Ambil tanggal transaksi terakhir
  * Hitung cash - change_pay
  * Auto cleanup tmp
  * Ready deploy Vercel
