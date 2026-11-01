// 9.1 / 9.2
const express = require('express');
const db = require('../db');
const { z, parse } = require('../lib/validate');
const { encodeCursor, decodeCursor, pageLimit } = require('../lib/format');
const alerts = require('../services/alerts');

const router = express.Router();

router.get('/', async (req, res) => {
  const limit = pageLimit(req.query.limit);
  const unreadOnly = req.query.unread === 'true';
  const cur = decodeCursor(req.query.cursor);
  const rows = await db.many(
    `SELECT n.*, COALESCE(d.name, d.serial_no) AS device_name FROM notifications n
       LEFT JOIN devices d ON d.id = n.device_id
      WHERE n.user_id = $1 AND (NOT $2 OR n.read_at IS NULL)
        AND ($3::bigint IS NULL OR n.id < $3)
      ORDER BY n.id DESC LIMIT $4`,
    [req.user.id, unreadOnly, cur ? cur.id : null, limit + 1],
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const unread = await db.one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({
    items: items.map(alerts.serialize),
    unread: unread.n,
    nextCursor: more ? encodeCursor({ id: items[items.length - 1].id }) : null,
  });
});

router.post('/read', async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.number().int()).max(500).optional(), all: z.boolean().optional() }), req.body);
  if (b.all) {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  } else if (b.ids && b.ids.length) {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [req.user.id, b.ids]);
  }
  res.status(204).end();
});

module.exports = router;
