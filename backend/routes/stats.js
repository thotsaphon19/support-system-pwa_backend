const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/dashboard', async (req, res, next) => {
  try {
    const total = (await db.get('SELECT COUNT(*) c FROM tickets')).c;
    const inProgress = (await db.get("SELECT COUNT(*) c FROM tickets WHERE status = 'กำลังดำเนินการ'")).c;
    const done = (await db.get("SELECT COUNT(*) c FROM tickets WHERE status = 'เสร็จสิ้น'")).c;
    const byChannel = await db.all('SELECT channel, COUNT(*) c FROM tickets GROUP BY channel');

    // last 7 days ticket counts
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const count = (await db.get('SELECT COUNT(*) c FROM tickets WHERE substring(created_at,1,10) = ?', [key])).c;
      days.push({ date: key, count: Number(count) });
    }

    res.json({
      total: Number(total),
      inProgress: Number(inProgress),
      done: Number(done),
      waiting: Number(total) - Number(inProgress) - Number(done),
      byChannel: byChannel.map(r => ({ ...r, c: Number(r.c) })),
      last7Days: days,
      satisfaction: { average: 4.8, totalReviews: 128 },
    });
  } catch (e) { next(e); }
});

module.exports = router;
