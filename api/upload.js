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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  await runMiddleware(req, res, upload.single("zipfile"));

  const file = req.file;
  const storeId = req.body.storeId?.toUpperCase();
  if (!file) return res.status(400).json({ error: "File ZIP wajib diupload" });
  if (!storeId) return res.status(400).json({ error: "Store ID tidak valid" });

  const raw = file.originalname.replace(".zip", "");
  const p = raw.split(/[_-]/);
  let detail = `Hasil Penjualan Toko ${storeId} | ${new Date().toLocaleDateString("id-ID")}`;
  if (p.length >= 5) detail = `Hasil Penjualan Toko ${p[0]} | ${p[3]}/${p[2]}/${p[1]} | NIK ${p[4]}`;

  const extractDir = path.join("/tmp", "extract_" + Date.now());
  try {
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(file.path);
    zip.extractAllTo(extractDir, true);

    const dbFile = fs.readdirSync(extractDir).find(f => f.toLowerCase().endsWith(".db") || f.toLowerCase().endsWith(".sqlite"));
    if (!dbFile) throw new Error("Database tidak ditemukan di ZIP");

    const db = new sqlite3.Database(path.join(extractDir, dbFile));
    db.get("SELECT COUNT(*) total FROM tx_tsale WHERE store_id = ?", [storeId], (err, row) => {
      if (err || !row || row.total === 0) { db.close(); return res.status(403).json({ error: "Data laporan bukan milik toko Anda" }); }
      // 🔥 Ambil tanggal transaksi terbaru
db.get(`
  SELECT MAX(date_tx) as last_date
  FROM tx_tsale
  WHERE store_id = ?
`, [storeId], (err, lastRow) => {

  if (err || !lastRow || !lastRow.last_date) {
    db.close();
    return res.status(500).json({
      error: "Tanggal transaksi terbaru tidak ditemukan"
    });
  }

  const lastDate = lastRow.last_date;

  // 🔥 Ambil setoran hanya dari tanggal terbaru
  db.get(`
    SELECT 
      SUM(cash) as cash,
      SUM(change_pay) as change
    FROM tx_tsale
    WHERE store_id = ?
    AND date_tx = ?
  `, [storeId, lastDate], (err, r) => {

    db.close();

    if (err) {
      return res.status(500).json({
        error: err.message
      });
    }

    res.json({
      title: "Hasil Laporan",
      detail,
      store_id: storeId,
      tanggal_setoran: lastDate,
      hasil: (r.cash || 0) - (r.change || 0)
    });

  });

});
}
); 
  
  catch (e) {
    res.status(500).json({ error: e.message });
  }
}
