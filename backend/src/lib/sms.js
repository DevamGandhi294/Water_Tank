// SMS sending. SMS_PROVIDER=none (default): no SMS, OTP endpoints are disabled.
// console: dev only, codes are logged and kept in memory for /dev/last-otp.
// msg91: MSG91 Flow API (template ids in .env).
const config = require('../config');
const logger = require('../logger');

const lastOtp = new Map(); // phone -> code (console provider only)

const enabled = () => config.sms.provider !== 'none';

async function msg91(templateId, phone, vars) {
  const res = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey: config.sms.msg91AuthKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [{ mobiles: phone.replace(/^\+/, ''), ...vars }] }),
  });
  if (!res.ok) throw new Error(`MSG91 ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendOtp(phone, code) {
  if (config.sms.provider === 'console') {
    lastOtp.set(phone, code);
    logger.info({ phone, code }, 'OTP (console SMS provider)');
    return;
  }
  if (config.sms.provider === 'msg91') return msg91(config.sms.msg91OtpTemplateId, phone, { otp: code });
  throw new Error('SMS disabled');
}

// invite for someone without an account yet; no-op when SMS is off
async function sendInvite(phone, ownerName, deviceName) {
  try {
    if (config.sms.provider === 'console') {
      logger.info({ phone, ownerName, deviceName }, 'invite SMS (console)');
    } else if (config.sms.provider === 'msg91' && config.sms.msg91InviteTemplateId) {
      await msg91(config.sms.msg91InviteTemplateId, phone, { name: ownerName, tank: deviceName, link: config.appLink });
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'invite SMS failed');
  }
}

module.exports = { enabled, sendOtp, sendInvite, lastOtp };
