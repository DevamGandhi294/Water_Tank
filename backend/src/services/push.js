// Firebase Cloud Messaging, used only for push. Without FCM_SERVICE_ACCOUNT_FILE it is a no-op.
const fs = require('fs');
const config = require('../config');
const logger = require('../logger');
const db = require('../db');

let messaging = null;
let tried = false;

function getMessaging() {
  if (tried) return messaging;
  tried = true;
  if (!config.fcmServiceAccountFile) {
    logger.info('FCM not configured, push notifications are stored but not sent');
    return null;
  }
  try {
    const admin = require('firebase-admin');
    const sa = JSON.parse(fs.readFileSync(config.fcmServiceAccountFile, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    messaging = admin.messaging();
  } catch (err) {
    logger.error({ err }, 'FCM init failed');
  }
  return messaging;
}

// Returns { sent: boolean, error?: string }
async function sendToUser(userId, { title, body, data }) {
  const m = getMessaging();
  if (!m) return { sent: false, error: 'fcm_not_configured' };
  const tokens = (await db.many('SELECT fcm_token FROM push_tokens WHERE user_id = $1', [userId])).map((r) => r.fcm_token);
  if (!tokens.length) return { sent: false, error: 'no_tokens' };
  try {
    const res = await m.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'tank_alerts' } },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') dead.push(tokens[i]);
    });
    if (dead.length) await db.query('DELETE FROM push_tokens WHERE fcm_token = ANY($1)', [dead]);
    return res.successCount > 0 ? { sent: true } : { sent: false, error: 'all_failed' };
  } catch (err) {
    logger.warn({ err: err.message }, 'FCM send failed');
    return { sent: false, error: err.message.slice(0, 200) };
  }
}

module.exports = { sendToUser };
