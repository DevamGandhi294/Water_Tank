const http = require('http');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const { createApp } = require('./app');
const realtime = require('./services/realtime');
const mqtt = require('./services/mqtt');
const live = require('./services/live');
const scheduler = require('./services/scheduler');

async function main() {
  await db.query('SELECT 1');
  const app = createApp();
  const server = http.createServer(app);
  realtime.init(server);
  live.start();
  mqtt.connect();
  scheduler.start();
  server.listen(config.port, () => logger.info({ port: config.port, env: process.env.NODE_ENV || 'development' }, 'backend listening'));

  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    scheduler.stop();
    server.close();
    await realtime.close().catch(() => {});
    await mqtt.close();
    await db.pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
