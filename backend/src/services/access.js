const db = require('../db');
const { E } = require('../errors');

const RANK = { view: 1, control: 2, owner: 3, admin: 4 };

async function getAccess(user, deviceId) {
  if (user.role === 'super_admin') return 'admin';
  const row = await db.one('SELECT access FROM device_access WHERE device_id = $1 AND user_id = $2', [deviceId, user.id]);
  return row ? row.access : null;
}

const can = (access, min) => !!access && RANK[access] >= RANK[min];

// Route guard: loads req.device (devices row) and req.access, requires at least `min`.
function deviceAccess(min) {
  return async (req, _res, next) => {
    try {
      const id = req.params.id;
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw E.notFound('DEVICE_NOT_FOUND', 'Tank not found');
      const device = await db.one('SELECT * FROM devices WHERE id = $1', [id]);
      if (!device) throw E.notFound('DEVICE_NOT_FOUND', 'Tank not found');
      const access = await getAccess(req.user, id);
      if (!access) throw E.forbidden('NO_ACCESS', 'You do not have access to this tank');
      if (!can(access, min)) {
        throw E.forbidden('NOT_ALLOWED', min === 'owner' ? 'Only the owner can do this' : 'You can only view this tank');
      }
      req.device = device;
      req.access = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// device ids this user can see (for socket subscribe)
async function accessibleDeviceIds(user, ids) {
  if (!ids.length) return [];
  if (user.role === 'super_admin') {
    return (await db.many('SELECT id FROM devices WHERE id = ANY($1::uuid[])', [ids])).map((r) => r.id);
  }
  return (await db.many('SELECT device_id FROM device_access WHERE user_id = $1 AND device_id = ANY($2::uuid[])', [user.id, ids]))
    .map((r) => r.device_id);
}

module.exports = { getAccess, can, deviceAccess, accessibleDeviceIds, RANK };
