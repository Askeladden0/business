import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from './db.js';
import { config } from './config.js';
import { findAccountById, normalizeEmail } from './accounts.js';

export const SESSION_COOKIE = 'rv_session';

function token(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function createMagicLink(email) {
  const value = token(32);
  const expires = new Date(Date.now() + config.magicLinkMinutes * 60_000).toISOString();
  getDb()
    .prepare('INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)')
    .run(value, normalizeEmail(email), expires);
  return { token: value, url: `${config.baseUrl}/auth/verifiser?token=${value}`, expiresAt: expires };
}

/** Brenner engangslenken. Returnerer e-postadressen, eller null hvis ugyldig. */
export function consumeMagicLink(value) {
  if (!value) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM magic_links WHERE token = ?').get(value);
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare("UPDATE magic_links SET used_at = datetime('now') WHERE token = ?").run(value);
  return row.email;
}

export function createSession(accountId) {
  const value = token(32);
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000).toISOString();
  getDb()
    .prepare('INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)')
    .run(value, accountId, expires);
  return { token: value, expiresAt: expires };
}

export function accountFromSession(value) {
  if (!value) return null;
  const row = getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(value);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE token = ?').run(value);
    return null;
  }
  return findAccountById(row.account_id) || null;
}

export function destroySession(value) {
  if (value) getDb().prepare('DELETE FROM sessions WHERE token = ?').run(value);
}

export function purgeExpiredAuth() {
  const db = getDb();
  const sessions = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  const links = db
    .prepare("DELETE FROM magic_links WHERE expires_at < datetime('now', '-1 day')")
    .run();
  return { sessions: sessions.changes, magicLinks: links.changes };
}

export function sessionCookie(value, { maxAgeSeconds } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds ?? config.sessionDays * 86_400}`,
  ];
  if (config.isProduction) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return sessionCookie('', { maxAgeSeconds: 0 });
}

/** Konstant-tids sammenlikning av to hemmeligheter oppgitt som strenger. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
