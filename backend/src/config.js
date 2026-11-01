// All settings come from environment variables (see ../../.env.example).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name, devDefault) {
  const v = env[name];
  if (v) return v;
  if (!isProd && devDefault !== undefined) return devDefault;
  throw new Error(`Missing required env var ${name}`);
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

const config = {
  isProd,
  port: int(env.PORT, 3000),
  publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  corsOrigins: list(env.CORS_ORIGINS || 'http://localhost:5173'),
  trustProxy: int(env.TRUST_PROXY, isProd ? 1 : 0),
  logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),

  databaseUrl: required('DATABASE_URL'),

  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  // HMAC key for claim codes and OTP codes (low entropy values are never stored as plain sha256)
  hashPepper: required('HASH_PEPPER', 'dev-only-pepper-change-me'),
  accessTtlS: int(env.ACCESS_TOKEN_TTL_S, 15 * 60),
  refreshTtlDays: int(env.REFRESH_TOKEN_TTL_DAYS, 30),

  mqtt: {
    url: env.MQTT_URL || 'mqtt://localhost:1883',
    // the backend's own login; Mosquitto asks the backend to check it too (superuser)
    username: env.MQTT_BACKEND_USERNAME || 'wt-backend',
    password: required('MQTT_BACKEND_PASSWORD', 'dev-backend-mqtt-password'),
    clientId: env.MQTT_CLIENT_ID || `wt-backend-${process.pid}`,
    // optional shared secret Mosquitto (go-auth) must send; empty = only network isolation
    authHookToken: env.MQTT_AUTH_HOOK_TOKEN || '',
  },

  // SMS: "none" (no OTP, phone + password only), "console" (dev: codes in the log), "msg91"
  sms: {
    provider: env.SMS_PROVIDER || 'none',
    msg91AuthKey: env.MSG91_AUTH_KEY || '',
    msg91OtpTemplateId: env.MSG91_OTP_TEMPLATE_ID || '',
    msg91InviteTemplateId: env.MSG91_INVITE_TEMPLATE_ID || '',
    msg91SenderId: env.MSG91_SENDER_ID || '',
  },

  googleClientIds: list(env.GOOGLE_CLIENT_IDS),

  fcmServiceAccountFile: env.FCM_SERVICE_ACCOUNT_FILE || '',

  otaDir: env.OTA_DIR || path.resolve(__dirname, '../data/ota'),
  otaTokenTtlS: int(env.OTA_TOKEN_TTL_S, 10 * 60),

  // device is marked offline if no MQTT message for this long (LWT usually comes first)
  deviceStaleS: int(env.DEVICE_STALE_S, 60),
  commandTtlS: int(env.COMMAND_TTL_S, 30),
  // live state is written to Postgres only when it changes, or at least this often
  stateHeartbeatS: int(env.STATE_HEARTBEAT_S, 60),

  devEndpoints: !isProd && env.DEV_ENDPOINTS === 'true',
  appLink: env.APP_LINK || 'https://watertank.ecobridgers.com/app',
};

module.exports = config;
