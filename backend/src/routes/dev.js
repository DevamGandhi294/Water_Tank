// Dev / test helpers. Mounted only when NODE_ENV != production and DEV_ENDPOINTS=true.
const express = require('express');
const sms = require('../lib/sms');
const { normalizePhone } = require('../lib/format');
const scheduler = require('../services/scheduler');

const router = express.Router();

router.get('/last-otp', (req, res) => {
  res.json({ code: sms.lastOtp.get(normalizePhone(String(req.query.phone || ''))) || null });
});

// run background jobs on demand (tests do not wait a full minute)
router.post('/jobs/:name', async (req, res) => {
  const { DateTime } = require('luxon');
  const jobs = {
    timers: () => scheduler.runTimers(req.body && req.body.at ? DateTime.fromISO(req.body.at) : undefined),
    'long-runs': () => scheduler.checkLongRuns(),
    'offline-alerts': () => scheduler.offlineAlerts(),
    cleanup: () => scheduler.cleanup(),
    stale: () => require('../services/live').sweepStale(),
    expiry: () => require('../services/commands').expireDue(),
  };
  if (!jobs[req.params.name]) return res.status(404).json({ error: { code: 'NO_JOB', message: 'Unknown job' } });
  await jobs[req.params.name]();
  res.json({ ok: true });
});

module.exports = router;
