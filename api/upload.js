import multer from "multer";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export const config = { api: { bodyParser: false } };

// ================= MULTER =================
const upload = multer({
  storage: multer.diskStorage({
    destination: "/tmp",
    filename: (req, file, cb) =>
      cb(null, Date.now() + "-" + file.originalname)
  }),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// ================= HELPER =================
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) =>
      result instanceof Error ? reject(result) : resolve(result)
    );
  });
}

// ================= HANDLER =================
export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let file;
  let extractDir;

  try {
    await runMiddleware(req, res, upload.single("zipfile"));

    file = req.file;
    const storeId = req.body.storeId?.toUpperCase();

    // ================= VALIDASI =================
    if (!file) {
      return res.status(400).json({ error: "File ZIP wajib diupload" });
    }

    if (!storeId) {
      return res.status(400).json({ error: "Store ID tidak valid" });
    }

    if (!file.originalname.toLowerCase().endsWith(".zip")) {
      return res.status(400).json({ error: "File harus format ZIP" });
    }

    // ================= DETAIL FILE =================
    const raw = file.originalname.replace(".zip", "");
    const p = raw.split(/[_-]/);

    let detail = `Hasil Penjualan Toko ${storeId}`;

    if (p.length >= 5) {
      detail = `Toko ${p[0]} | ${p[3]}/${p[2]}/${p[1]} | NIK ${p[4]}`;
    }

    // ================= EXTRACT =================
    extractDir = path.join("/tmp", "extract_" + Date.now());
    fs.mkdirSync(extractDir, { recursive: true });

    const zip = new AdmZip(file.path);
    zip.extractAllTo(extractDir, true);

    // ================= CARI DB =================
    const dbFile = fs.readdirSync(extractDir).find(f =>
      f.toLowerCase().endsWith(".db") ||
      f.toLowerCase().endsWith(".sqlite")
    );

    if (!dbFile) {
      throw new Error("Database tidak ditemukan di dalam ZIP");
    }

    const dbPath = path.join(extractDir, dbFile);
const db = new Database(dbPath, { readonly: true });

const totalRow = db.prepare(`
  SELECT COUNT(*) as total 
  FROM tx_tsale 
  WHERE store_id = ?
`).get(storeId);

if (!totalRow || totalRow.total === 0) {
  db.close();
  return res.status(403).json({
    error: "Data laporan bukan milik toko Anda"
  });
}

// 🔥 1. Ambil tanggal terbaru
const lastDateRow = db.prepare(`
  SELECT MAX(date_tx) as last_date
  FROM tx_tsale
  WHERE store_id = ?
`).get(storeId);

if (!lastDateRow || !lastDateRow.last_date) {
  db.close();
  return res.status(404).json({
    error: "Tanggal transaksi tidak ditemukan"
  });
}

const lastDate = lastDateRow.last_date;

// 🔥 2. Ambil data hanya di tanggal itu
const result = db.prepare(`
  SELECT 
    SUM(cash) as cash, 
    SUM(change_pay) as change_pay 
  FROM tx_tsale 
  WHERE store_id = ?
  AND date_tx = ?
`).get(storeId, lastDate);

db.close();

    const cash = Number(result.cash || 0);
    const change = Number(result.change_pay || 0);
    const total = cash - change;

    // ================= RESPONSE =================
    return res.json({
      title: "Hasil Laporan Setoran",
      detail,
      store_id: storeId,
      cash,
      change,
      hasil: total
    });

  } catch (e) {

    console.error("ERROR SETORAN:", e);

    return res.status(500).json({
      error: e.message || "Terjadi kesalahan server"
    });

  } finally {

    // ================= CLEANUP (WAJIB) =================
    try {
      if (file?.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }

      if (extractDir && fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.warn("Cleanup error:", cleanupErr);
    }

  }
}
