import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (config.isTest ? LEVELS.error : LEVELS.info);

const REDACTED = new Set([
  'password', 'token', 'secret', 'apikey', 'api_key', 'authorization',
  'stripe_secret_key', 'session', 'cookie', 'signature',
]);

function scrub(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED.has(k.toLowerCase()) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg: message, ...scrub(fields || {}) };
  if (line.err instanceof Error) {
    line.err = { name: line.err.name, message: line.err.message, stack: line.err.stack };
  }
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
