/**
 * logger.js
 * Structured logger (winston). Every module imports this directly.
 * Fields: timestamp, level, market (if provided), message, ...meta
 */
import winston from 'winston';
import { LOG_LEVEL } from './config.js';

const { combine, timestamp, colorize, printf, json } = winston.format;

const consoleFormat = printf(({ level, message, timestamp: ts, market, ...meta }) => {
  const mkt = market ? ` [${market}]` : '';
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} ${level}${mkt}: ${message}${extra}`;
});

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), json()),
  transports: [
    new winston.transports.Console({
      format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), colorize(), consoleFormat),
    }),
    new winston.transports.File({
      filename: 'bot.log',
      format: combine(timestamp(), json()),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

export default logger;

/**
 * Returns a child logger that automatically includes the market slug in every log line.
 */
export function marketLogger(slug) {
  return logger.child({ market: slug });
}
