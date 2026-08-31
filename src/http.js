import { config } from './config.js';

export const MAX_BODY_BYTES = 1_000_000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Leser hele forespørselskroppen som Buffer, med en hard øvre grense. */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Forespørselen er for stor'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseForm(buffer) {
  const params = new URLSearchParams(buffer.toString('utf8'));
  const out = {};
  for (const [key, value] of params) {
    if (key in out) {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function parseJson(buffer) {
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Ugyldig JSON');
  }
}

export function cookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Ingen tredjepartsskript i dette produktet; Stripe Checkout er en
  // omdirigering til deres eget domene, ikke et innebygd skript.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'self'",
};

export function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  res.writeHead(status, {
    'Content-Length': payload.length,
    ...SECURITY_HEADERS,
    ...(config.isProduction
      ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
      : {}),
    ...headers,
  });
  if (res.req && res.req.method === 'HEAD') res.end();
  else res.end(payload);
}

export function html(res, status, markup, headers = {}) {
  send(res, status, markup, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
}

export function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value, null, 2), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

export function text(res, status, value, headers = {}) {
  send(res, status, value, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
}

export function redirect(res, location, status = 303, headers = {}) {
  send(res, status, '', { Location: location, ...headers });
}

/**
 * CSRF-vern. Sesjonsinformasjonskapselen er SameSite=Lax, som allerede stopper
 * skjemaposteringer fra andre nettsteder; Origin-sjekken er andre lag.
 */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Ingen Origin sendes ved vanlig navigasjon.
  try {
    return new URL(origin).origin === new URL(config.baseUrl).origin;
  } catch {
    return false;
  }
}

export function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'ukjent';
}

/** Enkel takstbegrenser i minnet. Nok for én maskin og dette volumet. */
const buckets = new Map();

export function rateLimit(key, { max = 10, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { ok: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: max - bucket.count };
}

export function resetRateLimits() {
  buckets.clear();
}

// Rydder utløpte bøtter så kartet ikke vokser i det uendelige.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(key);
}, 300_000);
if (sweep.unref) sweep.unref();
