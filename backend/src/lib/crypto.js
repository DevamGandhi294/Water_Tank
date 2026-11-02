const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', config.hashPepper).update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Claim code like K7P2-9XQM. No 0/O/1/I/L/U so it can be typed from a sticker.
const CLAIM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
function claimCode() {
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += CLAIM_ALPHABET[bytes[i] % CLAIM_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
// QR claim token (WT2 stickers): 16 random chars, about 78 bits, shown as
// XXXX-XXXX-XXXX-XXXX. The device is found by the token's hash alone, so the
// QR carries no serial or MAC.
function claimToken() {
  let s = '';
  for (let i = 0; i < 16; i++) s += CLAIM_ALPHABET[crypto.randomInt(CLAIM_ALPHABET.length)];
  return s.match(/.{4}/g).join('-');
}
const normalizeClaimCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const claimCodeHash = (code) => hmac(`claim:${normalizeClaimCode(code)}`);

const otpCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const otpHash = (phone, purpose, code) => hmac(`otp:${phone}:${purpose}:${code}`);

const hashPassword = (pw) => bcrypt.hash(pw, 11);
const checkPassword = (pw, hash) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

module.exports = {
  sha256, hmac, randomToken, claimCode, claimToken, normalizeClaimCode, claimCodeHash,
  otpCode, otpHash, hashPassword, checkPassword, safeEqual,
};
