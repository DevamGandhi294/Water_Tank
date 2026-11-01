const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: config.logLevel,
  redact: ['req.headers.authorization', 'password', 'newPassword', 'refreshToken'],
  ...(config.isProd || process.env.LOG_PRETTY === 'false'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

module.exports = logger;
