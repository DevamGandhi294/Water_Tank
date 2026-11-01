// Browser smoke test of the admin panel (Playwright in Docker, see README).
// Needs the dev stack + vite dev server and the test admin (+919000000001 / adminpass1, created by backend npm test).
const { chromium } = require('playwright');
const SP = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await p.goto(process.env.ADMIN_URL || 'http://localhost:5173/');
  await p.fill('#ph', '+919000000001');
  await p.fill('#pw', 'adminpass1');
  await p.click('button:has-text("Log in")');
  await p.waitForSelector('text=Total devices');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SP}/shots/1-dashboard.png`, fullPage: true });
  await p.click('a.nav:has-text("Devices")');
  await p.waitForSelector('table tbody tr');
  await p.screenshot({ path: `${SP}/shots/2-devices.png`, fullPage: true });
  // register a device
  await p.click('a.nav:has-text("Register device")');
  const mac = () => Array.from({ length: 6 }, (_, i) => (i ? Math.floor(Math.random() * 256) : 2).toString(16).padStart(2, '0')).join(':').toUpperCase();
  await p.fill('#rm', mac()); await p.fill('#rs', mac());
  await p.click('button:has-text("Register and make QR")');
  await p.waitForSelector('text=Registered');
  await p.screenshot({ path: `${SP}/shots/3-register.png`, fullPage: true });
  await p.click('a:has-text("Open device")');
  await p.waitForSelector('text=Actions');
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${SP}/shots/4-device.png`, fullPage: true });
  await p.click('button:has-text("Edit settings")');
  await p.fill('#sc', '20');
  const errShown = await p.isVisible('text=Cutoff must be at least 25 cm');
  await p.fill('#sc', '40');
  await p.click('button:has-text("Save and send")');
  await p.waitForSelector('text=Cutoff 40 cm');
  await p.click('a.nav:has-text("Users")');
  await p.waitForSelector('table tbody tr');
  await p.screenshot({ path: `${SP}/shots/5-users.png`, fullPage: true });
  await p.click('table tbody tr >> nth=0');
  await p.waitForSelector('text=Actions');
  await p.screenshot({ path: `${SP}/shots/6-user.png`, fullPage: true });
  await p.click('a.nav:has-text("Firmware")');
  await p.waitForSelector('text=Releases');
  await p.screenshot({ path: `${SP}/shots/7-firmware.png`, fullPage: true });
  const roll = await p.$('table a[href^="/firmware/rollouts/"]');
  if (roll) { await roll.click(); await p.waitForSelector('text=From'); await p.screenshot({ path: `${SP}/shots/8-rollout.png`, fullPage: true }); }
  await p.click('a.nav:has-text("Audit")');
  await p.waitForSelector('table tbody tr');
  await p.screenshot({ path: `${SP}/shots/9-audit.png`, fullPage: true });
  // phone width
  await p.setViewportSize({ width: 390, height: 844 });
  await p.click('a.nav:has-text("Dashboard")');
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${SP}/shots/10-mobile.png`, fullPage: true });
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  console.log(JSON.stringify({ cutoffErrorShown: errShown, mobileScrollWidth: sw, errors }, null, 1));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
