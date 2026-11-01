// MQTT connection of the backend. Devices publish under wt/<mqtt_username>/...
// Incoming messages are passed to the handler set with onMessage().
const mqtt = require('mqtt');
const config = require('../config');
const logger = require('../logger');

let client = null;
let handler = async () => {};

const SUBSCRIPTIONS = ['wt/+/status', 'wt/+/state', 'wt/+/event', 'wt/+/cmd/ack', 'wt/+/settings/ack', 'wt/+/ota/status'];

function connect() {
  client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: config.mqtt.clientId,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10_000,
  });
  client.on('connect', () => {
    logger.info({ url: config.mqtt.url }, 'mqtt connected');
    client.subscribe(SUBSCRIPTIONS.map((t) => t), { qos: 1 }, (err) => {
      if (err) logger.error({ err }, 'mqtt subscribe failed');
    });
  });
  client.on('reconnect', () => logger.debug('mqtt reconnecting'));
  client.on('error', (err) => logger.warn({ err: err.message }, 'mqtt error'));
  client.on('message', (topic, buf, packet) => {
    const m = /^wt\/([^/]+)\/(.+)$/.exec(topic);
    if (!m) return;
    const text = buf.toString('utf8');
    let payload = text;
    if (text.startsWith('{')) {
      try {
        payload = JSON.parse(text);
      } catch {
        logger.warn({ topic, text }, 'mqtt: bad json');
        return;
      }
    }
    Promise.resolve(handler(m[1], m[2], payload, packet)).catch((err) =>
      logger.error({ err, topic }, 'mqtt handler failed'),
    );
  });
  return client;
}

function onMessage(fn) {
  handler = fn;
}

const isConnected = () => !!(client && client.connected);

// Resolves true when the broker has the message (QoS 1), false when not connected.
function publish(topic, payload, { qos = 1, retain = false } = {}) {
  return new Promise((resolve) => {
    if (!isConnected()) return resolve(false);
    const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    client.publish(topic, body, { qos, retain }, (err) => {
      if (err) logger.warn({ err: err.message, topic }, 'mqtt publish failed');
      resolve(!err);
    });
  });
}

const deviceTopic = (username, suffix) => `wt/${username}/${suffix}`;

async function close() {
  if (client) await client.endAsync().catch(() => {});
}

module.exports = { connect, onMessage, publish, isConnected, deviceTopic, close };
