import multer from "multer";
import AdmZip from "adm-zip";
import sqlite3 from "sqlite3";
import fs from "fs";
import path from "path";

export const config = { api: { bodyParser: false } };

const upload = multer({
  storage: multer.diskStorage({
    destination: "/tmp",
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => result instanceof Error ? reject(result) : resolve(result));
  });
}

// Helper Async untuk Query SQLite3
const dbGet = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAll = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let file;
  let extractDir;

  try {
    await runMiddleware(req, res, upload.single("zipfile"));

    file = req.file;
    const storeId = req.body.storeId?.toUpperCase();

    if (!file) return res.status(400).json({ error: "File ZIP wajib diupload" });
    if (!storeId) return res.status(400).json({ error: "Store ID tidak valid" });

    const raw = file.originalname.replace(".zip", "");
    const p = raw.split(/[_-]/);
    let detail = `Hasil Penjualan Toko ${storeId} | ${new Date().toLocaleDateString("id-ID")}`;
    if (p.length >= 5) detail = `Hasil Penjualan Toko ${p[0]} | ${p[3]}/${p[2]}/${p[1]} | NIK ${p[4]}`;

    extractDir = path.join("/tmp", "extract_" + Date.now());
    fs.mkdirSync(extractDir, { recursive: true });

    const zip = new AdmZip(file.path);
    zip.extractAllTo(extractDir, true);

    const dbFile = fs.readdirSync(extractDir).find(
      (f) => f.toLowerCase().endsWith(".db") || f.toLowerCase().endsWith(".sqlite")
    );
    if (!dbFile) throw new Error("Database tidak ditemukan di ZIP");

    const db = new sqlite3.Database(path.join(extractDir, dbFile));

    // Validasi Toko
    const checkStore = await dbGet(db, "SELECT COUNT(*) AS total FROM tx_tsale WHERE store_id = ?", [storeId]);
    if (!checkStore || checkStore.total === 0) {
      db.close();
      return res.status(403).json({ error: "Data laporan bukan milik toko Anda" });
    }

    // 1. CARI TANGGAL PALING BARU (DD/MM/YYYY -> YYYY-MM-DD)
    const latestDateRow = await dbGet(
      db,
      `
      SELECT date_tx 
      FROM tx_tsale 
      WHERE store_id = ?
      ORDER BY 
        substr(date_tx, 7, 4) || '-' || substr(date_tx, 4, 2) || '-' || substr(date_tx, 1, 2) DESC,
        rowid DESC
      LIMIT 1
      `,
      [storeId]
    );

    if (!latestDateRow || !latestDateRow.date_tx) {
      db.close();
      return res.status(404).json({ error: "Tanggal transaksi tidak ditemukan" });
    }

    const lastDate = latestDateRow.date_tx;

    // 2. HITUNG HASIL CLEREK HANYA UNTUK TANGGAL TERBARU
    const summary = await dbGet(
      db,
      `
      SELECT 
        date_tx AS TANGGAL, 
        GROUP_CONCAT(DISTINCT user_id) AS "NIK Kasir", 
        SUM(cash - change_pay) AS net_total,
        printf('%,d', SUM(cash - change_pay)) AS "Hasil Clerek" 
      FROM tx_tsale 
      WHERE store_id = ? AND date_tx = ?
      GROUP BY date_tx
      `,
      [storeId, lastDate]
    );

    // 3. AMBIL LOG RECEIPT PRN UNTUK TRANSAKSI TANGGAL TERBARU
    let receipts = [];
    try {
      receipts = await dbAll(
        db,
        `
        SELECT DISTINCT
          l.bill_no,
          l.date_tx,
          t.cust_id,
          t.phone,
          t.cash,
          t.change_pay,
          l.header,
          l.body1,
          l.body2,
          l.body3,
          l.addtl1,
          l.addtl2,
          l.addtl3,
          l.footer
        FROM log_receipt_prn l
        INNER JOIN tx_tsale t ON CAST(l.bill_no AS TEXT) = substr(t.faktur, -4)
        WHERE t.store_id = ? AND t.date_tx = ?
        ORDER BY l.date_tx DESC
        `,
        [storeId, lastDate]
      );
    } catch (err) {
      receipts = [];
    }

    db.close();

    return res.status(200).json({
      title: "Hasil Laporan Setoran",
      detail,
      store_id: storeId,
      tanggal: summary?.TANGGAL || lastDate,
      nik_kasir: summary?.["NIK Kasir"] || "-",
      hasil_clerek_formatted: summary?.["Hasil Clerek"] || "0",
      hasil: Number(summary?.net_total || 0),
      total_receipt: receipts.length,
      receipts
    });

  } catch (e) {
    console.error("ERROR SETORAN:", e);
    return res.status(500).json({ error: e.message || "Terjadi kesalahan server" });
  } finally {
    // Pembersihan File & Folder Temp
    try {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      if (extractDir && fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn("Cleanup error:", cleanupErr);
    }
  }
}
