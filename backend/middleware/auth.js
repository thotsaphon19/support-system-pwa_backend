const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../lib/tokens');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ไม่พบ token กรุณาเข้าสู่ระบบใหม่' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token หมดอายุหรือไม่ถูกต้อง', code: 'TOKEN_EXPIRED' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    }
    next();
  };
}

// Gates a route behind one of the admin permission keys assigned in the Team &
// Permissions screen (see routes/team.js). The owner account always has every
// permission implicitly, regardless of what's in their `permissions` array.
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    if (req.user.isOwner) return next();
    const perms = req.user.permissions || [];
    if (!perms.includes(key)) return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ใช้งานส่วนนี้ กรุณาติดต่อเจ้าของร้าน' });
    next();
  };
}

module.exports = { requireAuth, requireRole, requirePermission, JWT_SECRET };
