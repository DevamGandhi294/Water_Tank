const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const mqtt = require('./services/mqtt');
const { ApiError } = require('./errors');
const { requireUser } = require('./middleware/auth');

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  // Mosquitto auth hook (internal only), before CORS / JSON limits for the API
  app.use('/mqtt', express.json({ limit: '4kb' }), require('./routes/mqttAuth').router);

  // firmware downloads (devices) and the legacy version.json
  app.use(require('./routes/firmwareFiles'));

  app.get('/health', async (_req, res) => {
    let dbOk = false;
    try { await db.query('SELECT 1'); dbOk = true; } catch { /* reported below */ }
    const ok = dbOk && mqtt.isConnected();
    res.status(ok ? 200 : 503).json({ ok, db: dbOk, mqtt: mqtt.isConnected(), time: new Date().toISOString() });
  });

  const api = express.Router();
  api.use(cors({ origin: config.corsOrigins, credentials: true }));
  api.use(express.json({ limit: '200kb' }));

  api.use('/auth', require('./routes/auth').router);
  api.use('/me', requireUser, require('./routes/me'));
  api.use('/devices', requireUser, require('./routes/devices').router);
  api.use('/invites', requireUser, require('./routes/invites'));
  api.use('/notifications', requireUser, require('./routes/notifications'));
  api.use('/admin', requireUser, require('./routes/admin').router);
  if (config.devEndpoints) api.use('/dev', require('./routes/dev'));

  api.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'No such endpoint')));
  app.use('/api/v1', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ApiError) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json({ error: body });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Body is not valid JSON' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } });
    }
    logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong' } });
  });

  return app;
}

module.exports = { createApp };
