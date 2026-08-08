const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

// Files are held in memory just long enough to be written into Postgres/Neon (see the
// `media` table in db.js) — never written to local disk, which would be lost on the
// next deploy/cold start on serverless/ephemeral hosts.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME[file.mimetype]) {
      return cb(new Error('รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, WEBP หรือ GIF เท่านั้น'));
    }
    cb(null, true);
  },
});

// Saves an already-validated multer file buffer into the `media` table and returns
// the public { url, filename, size } for it. Shared by handleUpload below and by other
// routes (e.g. routes/auth.js's avatar upload) that need the same store-in-Neon behavior
// without going through a whole extra HTTP round trip.
async function saveFileToMedia(req, file) {
  const id = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  await db.run('INSERT INTO media (id, mime_type, data, size) VALUES (?,?,?,?)',
    [id, file.mimetype, file.buffer, file.size]);
  const origin = `${req.protocol}://${req.get('host')}`;
  const url = `${origin}/media/${id}`;
  return { url, filename: id, size: file.size };
}

async function handleUpload(req, res) {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'ไฟล์รูปภาพต้องมีขนาดไม่เกิน 5MB'
        : err.message || 'อัปโหลดไฟล์ไม่สำเร็จ';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์รูปภาพ' });

    try {
      const result = await saveFileToMedia(req, req.file);
      res.json(result);
    } catch (e) {
      console.error('[upload] failed to save to database', e);
      res.status(500).json({ error: 'บันทึกไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' });
    }
  });
}

// POST /api/upload/product-image — admin only. multipart/form-data, field name "image".
// Stores the file in the database and returns a URL the frontend can save straight into
// a product's image_url field.
router.post('/product-image', requireAuth, requireRole('admin'), handleUpload);

// POST /api/upload/image — admin only. Generic image upload used for app branding
// (app logo, payment method logos, etc). Same storage/validation as product images.
router.post('/image', requireAuth, requireRole('admin'), handleUpload);

// POST /api/upload/payment-slip — any logged-in customer. Used when a customer uploads
// proof-of-transfer (PromptPay/bank transfer slip) after paying an order's QR code.
router.post('/payment-slip', requireAuth, requireRole('customer'), handleUpload);

// POST /api/upload/chat-image — any logged-in user (customer or admin). Used for sending
// a photo/file attachment inside the support chat.
router.post('/chat-image', requireAuth, handleUpload);

module.exports = router;
// Exported so other routes (routes/auth.js — profile avatar upload) can reuse the same
// validated multer instance + Neon storage helper instead of duplicating upload logic.
module.exports.upload = upload;
module.exports.saveFileToMedia = saveFileToMedia;
