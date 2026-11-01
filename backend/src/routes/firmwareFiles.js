// 11.1 /fw/:id.bin?t=<token>  (signed link sent in the MQTT OTA message)
// 11.2 /ota/version.json + /ota/firmware/<file>  (legacy, so v1.3 boards keep updating)
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const { verifyPurpose } = require('../services/tokens');

const router = express.Router();

function sendBin(res, r) {
  if (!fs.existsSync(r.file_path)) return res.status(404).json({ error: { code: 'FILE_MISSING', message: 'Firmware file missing' } });
  const buf = fs.readFileSync(r.file_path);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(buf.length),
    'Content-Disposition': `attachment; filename="${path.basename(r.file_path)}"`,
    'x-MD5': crypto.createHash('md5').update(buf).digest('hex'), // ESP8266httpUpdate checks this
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

router.get('/fw/:file', async (req, res) => {
  const m = /^(\d+)\.bin$/.exec(req.params.file);
  const claims = verifyPurpose('fw', String(req.query.t || ''));
  if (!m || !claims || claims.fid !== parseInt(m[1], 10)) {
    return res.status(403).json({ error: { code: 'INVALID_LINK', message: 'Download link expired' } });
  }
  const r = await db.one('SELECT * FROM firmware_releases WHERE id = $1', [claims.fid]);
  if (!r) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  sendBin(res, r);
});

router.get('/ota/version.json', async (_req, res) => {
  const r = await db.one(`SELECT * FROM firmware_releases WHERE board = 'main' AND is_stable`);
  res.set('Cache-Control', 'no-store');
  if (!r) return res.status(404).json({ error: { code: 'NO_STABLE_RELEASE', message: 'No stable firmware yet' } });
  res.json({ version: r.version, url: `${config.publicBaseUrl}/ota/firmware/${path.basename(r.file_path)}` });
});

router.get('/ota/firmware/:name', async (req, res) => {
  if (!/^[a-z_]+_[\d.]+\.bin$/.test(req.params.name)) return res.status(404).end();
  const r = await db.one(`SELECT * FROM firmware_releases WHERE file_path LIKE '%/' || $1`, [req.params.name]);
  if (!r) return res.status(404).end();
  sendBin(res, r);
});

module.exports = router;
