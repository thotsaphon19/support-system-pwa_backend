// routes/media.js — serves images that were uploaded and stored in Postgres/Neon
// (see routes/upload.js + the `media` table in db.js) instead of local disk.
//
// Why a database instead of disk: on serverless/ephemeral hosts (Vercel, Render, etc.)
// anything written to local disk disappears on the next deploy or cold start. Storing
// the actual image bytes as a row in Neon means uploaded product photos, branding, and
// payment slips survive redeploys automatically, same as any other data in the app.
const express = require('express');
const { db } = require('../db');

const router = express.Router();

// GET /media/:id — public (product photos/branding are meant to be publicly viewable,
// same as any storefront CDN asset). The id itself is an unguessable random token (see
// upload.js), so this isn't a real access-control mechanism for the payment-slip case —
// same trust model the old /uploads/:filename disk route had.
router.get('/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT mime_type, data FROM media WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบไฟล์' });
    res.setHeader('Content-Type', row.mime_type);
    // The URL contains a random id and a file's contents never change once uploaded
    // (re-uploading creates a new row/URL), so caching it forever in the browser is safe.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(row.data);
  } catch (e) { next(e); }
});

module.exports = router;
