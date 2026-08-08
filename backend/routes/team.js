const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// Only the "owner" admin account can add/edit/remove teammates or change anyone's
// permissions — otherwise a staff member could hand themselves (or a friend) full
// access. Exactly one admin is always marked owner (see db.js migration backfill).
function requireOwner(req, res, next) {
  if (!req.user.isOwner) return res.status(403).json({ error: 'เฉพาะเจ้าของร้านเท่านั้นที่จัดการทีมงานได้' });
  next();
}

const VALID_PERMISSIONS = ['dashboard','inbox','products','categories','storeOrders','reviews','marketing','tickets','tasks','customers','finance','channels','kb','reports','settings'];

// GET /api/team — list every admin account (owner only)
router.get('/', requireOwner, async (req, res, next) => {
  try {
    const rows = await db.all(
      "SELECT id, name, username, phone, position, permissions, is_owner, created_at FROM users WHERE role = 'admin' ORDER BY is_owner DESC, created_at ASC"
    );
    res.json(rows.map(r => ({ ...r, permissions: JSON.parse(r.permissions || '[]') })));
  } catch (e) { next(e); }
});

// POST /api/team — invite a new teammate with a starting permission set
router.post('/', requireOwner, async (req, res, next) => {
  try {
    const { username, password, name, phone, position, permissions } = req.body || {};
    if (!username || !password || !name) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้ รหัสผ่าน และชื่อ' });
    if (String(password).length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });

    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(409).json({ error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' });

    const perms = Array.isArray(permissions) ? permissions.filter(p => VALID_PERMISSIONS.includes(p)) : [];
    const hash = bcrypt.hashSync(password, 10);
    const info = await db.run(
      "INSERT INTO users (role, username, password_hash, name, phone, position, permissions) VALUES ('admin',?,?,?,?,?,?)",
      [username, hash, name, phone || null, position || null, JSON.stringify(perms)]
    );
    const row = await db.get("SELECT id, name, username, phone, position, permissions, is_owner, created_at FROM users WHERE id = ?", [info.lastInsertRowid]);
    res.status(201).json({ ...row, permissions: JSON.parse(row.permissions || '[]') });
  } catch (e) { next(e); }
});

// PUT /api/team/:id — edit a teammate's profile/permissions, optionally reset password
router.put('/:id', requireOwner, async (req, res, next) => {
  try {
    const member = await db.get("SELECT id, is_owner FROM users WHERE id = ? AND role = 'admin'", [req.params.id]);
    if (!member) return res.status(404).json({ error: 'ไม่พบทีมงาน' });

    const { name, phone, position, permissions, password } = req.body || {};
    if (name !== undefined) await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.params.id]);
    if (phone !== undefined) await db.run('UPDATE users SET phone = ? WHERE id = ?', [phone || null, req.params.id]);
    if (position !== undefined) await db.run('UPDATE users SET position = ? WHERE id = ?', [position || null, req.params.id]);
    // The owner's own access can't be narrowed by this endpoint — they always have
    // everything, by definition of being the owner — so permission edits here only
    // ever apply to non-owner teammates.
    if (permissions !== undefined && !member.is_owner) {
      const perms = Array.isArray(permissions) ? permissions.filter(p => VALID_PERMISSIONS.includes(p)) : [];
      await db.run('UPDATE users SET permissions = ? WHERE id = ?', [JSON.stringify(perms), req.params.id]);
    }
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), req.params.id]);
    }

    const row = await db.get("SELECT id, name, username, phone, position, permissions, is_owner, created_at FROM users WHERE id = ?", [req.params.id]);
    res.json({ ...row, permissions: JSON.parse(row.permissions || '[]') });
  } catch (e) { next(e); }
});

// DELETE /api/team/:id — remove a teammate (never yourself, never the last owner)
router.delete('/:id', requireOwner, async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'ไม่สามารถลบบัญชีของตัวเองได้' });
    const member = await db.get("SELECT id, is_owner FROM users WHERE id = ? AND role = 'admin'", [req.params.id]);
    if (!member) return res.status(404).json({ error: 'ไม่พบทีมงาน' });
    if (member.is_owner) return res.status(400).json({ error: 'ไม่สามารถลบบัญชีเจ้าของร้านได้' });

    await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    if (e && (e.code === '23503' || /foreign key/i.test(e.message || ''))) {
      return res.status(409).json({ error: 'ไม่สามารถลบทีมงานคนนี้ได้ เนื่องจากมีข้อมูลผูกอยู่ในระบบ (เช่น งานที่รับผิดชอบ)' });
    }
    next(e);
  }
});

module.exports = router;
