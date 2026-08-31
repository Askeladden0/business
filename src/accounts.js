import { randomBytes } from 'node:crypto';
import { getDb } from './db.js';
import { effectivePlan } from './plans.js';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function isValidEmail(email) {
  const value = normalizeEmail(email);
  return value.length <= 254 && EMAIL_RE.test(value);
}

export function findAccountByEmail(email) {
  return getDb().prepare('SELECT * FROM accounts WHERE email = ?').get(normalizeEmail(email));
}

export function findAccountById(id) {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function findAccountByStripeCustomer(customerId) {
  if (!customerId) return undefined;
  return getDb().prepare('SELECT * FROM accounts WHERE stripe_customer_id = ?').get(customerId);
}

export function findAccountByApiKey(apiKey) {
  if (!apiKey) return undefined;
  return getDb().prepare('SELECT * FROM accounts WHERE api_key = ?').get(apiKey);
}

export function createAccount(email, fields = {}) {
  const db = getDb();
  const normalized = normalizeEmail(email);
  db.prepare(
    `INSERT INTO accounts (email, plan, status, stripe_customer_id, api_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    normalized,
    fields.plan || 'gratis',
    fields.status || 'active',
    fields.stripe_customer_id || null,
    `rv_${randomBytes(24).toString('base64url')}`,
  );
  return findAccountByEmail(normalized);
}

export function ensureAccount(email, fields = {}) {
  return findAccountByEmail(email) || createAccount(email, fields);
}

const UPDATABLE = new Set([
  'plan', 'status', 'stripe_customer_id', 'stripe_subscription_id', 'current_period_end',
  'alert_level', 'delivery_mode', 'extra_recipients', 'webhook_url', 'webhook_kind',
  'webhook_secret', 'api_key', 'email',
]);

export function updateAccount(id, fields) {
  const entries = Object.entries(fields).filter(([key]) => UPDATABLE.has(key));
  if (!entries.length) return findAccountById(id);
  const setSql = entries.map(([key]) => `${key} = ?`).join(', ');
  getDb()
    .prepare(`UPDATE accounts SET ${setSql}, updated_at = datetime('now') WHERE id = ?`)
    .run(...entries.map(([, value]) => value), id);
  return findAccountById(id);
}

export function rotateApiKey(id) {
  return updateAccount(id, { api_key: `rv_${randomBytes(24).toString('base64url')}` });
}

/** Alle e-postadresser som skal motta varsler for kontoen, innenfor plangrensen. */
export function recipientsFor(account) {
  const plan = effectivePlan(account);
  const extra = String(account.extra_recipients || '')
    .split(/[,;\s]+/)
    .map(normalizeEmail)
    .filter((value) => value && isValidEmail(value) && value !== normalizeEmail(account.email));
  return [normalizeEmail(account.email), ...[...new Set(extra)].slice(0, plan.maxExtraRecipients)];
}

export function countAccounts() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
}
