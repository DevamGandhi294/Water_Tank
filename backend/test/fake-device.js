// Simulated ESP main board for local testing (no hardware needed).
//   npm run fake-device -- A4:CF:12:9B:42:10 [mqtt://localhost:1883]
// The MAC must be registered in the admin panel first. The board fills when the
// pump is on (1 cm per state message), drains slowly when it is off, stops at the
// cutoff like the real firmware, and answers cmd / settings / ota.
const { FakeDevice } = require('./helpers');

const mac = process.argv[2];
if (!mac) {
  console.error('usage: npm run fake-device -- <main board MAC> [mqtt url]');
  process.exit(1);
}
if (process.argv[3]) process.env.TEST_MQTT_URL = process.argv[3];

(async () => {
  const d = new FakeDevice(mac);
  d.state = { st: 'WORK', pump: 0, cm: 120, rssi: -60, up: 0, fw: '1.4', snd: 1 };
  d.settings = { cutoff_cm: 25, auto: 1 };
  const orig = d.onMessage.bind(d);
  d.onMessage = (topic, text) => {
    console.log('<-', topic, text);
    orig(topic, text);
  };
  await d.connect();
  console.log(`connected as ${d.username}`);
  await d.pub('event', { t: 'reboot', reason: 'power' });
  setInterval(async () => {
    d.state.up += 5;
    if (d.state.pump) d.state.cm = Math.round((d.state.cm - 1) * 10) / 10;
    else d.state.cm = Math.min(150, Math.round((d.state.cm + 0.1) * 10) / 10);
    if (d.state.pump && d.state.cm <= d.settings.cutoff_cm) {
      d.state.pump = 0;
      await d.pub('event', { t: 'auto_cutoff', cm: d.state.cm });
      console.log('-> auto cutoff at', d.state.cm);
    }
    await d.sendState();
    console.log('-> state', JSON.stringify(d.state));
  }, 5000);
})().catch((e) => {
  console.error('could not connect:', e.message);
  process.exit(1);
});
