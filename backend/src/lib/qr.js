const QRCode = require('qrcode');

// QR text on the sticker: WT2:<token> (16 chars, no dashes). It holds no
// serial, MAC or date, so a normal scanner only shows random letters.
// Old stickers (WT1:<serial>:<claimCode>) are still accepted by the app.
const qrPayload = (token) => `WT2:${String(token).replace(/-/g, '')}`;

// "02 Nov 2026"
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

async function qrPngBase64(text) {
  const url = await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
  return url.replace(/^data:image\/png;base64,/, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Printable A4 sheet of stickers (3 per row), opened from the admin panel
function stickerSheetHtml(items) {
  const cells = items.map((i) => `<div class="s"><img src="data:image/png;base64,${i.qrPngBase64}" alt="">
    <div><b>${escapeHtml(i.serial)}</b><br>Reg: ${escapeHtml(fmtDay(i.registeredAt))}<br>Code: ${escapeHtml(i.claimCode)}<br><small>Scan in the Water Tank app</small></div></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Stickers</title><style>
  @page{size:A4;margin:10mm} body{font-family:monospace;margin:0}
  .g{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}
  .s{border:1px dashed #999;padding:3mm;display:flex;gap:3mm;align-items:center;break-inside:avoid;font-size:10pt}
  .s img{width:28mm;height:28mm}</style></head><body><div class="g">${cells}</div></body></html>`;
}

module.exports = { qrPayload, fmtDay, qrPngBase64, stickerSheetHtml };
