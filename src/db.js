import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './log.js';

const here = dirname(fileURLToPath(import.meta.url));

let db = null;

export function getDb() {
  if (db) return db;
  const path = config.databasePath;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  log.info('database ready', { path });
  return db;
}

/** Kun for tester: bytter til en fersk in-memory-database. */
export function resetDbForTests() {
  if (db) db.close();
  db = null;
  config.databasePath = ':memory:';
  return getDb();
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Tolker et tidsstempel fra basen. SQLites datetime('now') gir
 * 'YYYY-MM-DD HH:MM:SS' i UTC uten sone, mens vi selv skriver full ISO.
 * Returnerer millisekunder, eller null hvis strengen ikke kan tolkes.
 */
export function parseDbTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = /[TZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// --- kv -------------------------------------------------------------------

export function kvGet(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function kvSet(key, value) {
  getDb()
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value === null || value === undefined ? null : String(value));
}

// --- jobbhistorikk --------------------------------------------------------

export function recordJobRun({ job, status, startedAt, durationMs, detail, error }) {
  getDb()
    .prepare(
      `INSERT INTO job_runs (job, status, started_at, finished_at, duration_ms, detail, error)
       VALUES (?, ?, ?, datetime('now'), ?, ?, ?)`,
    )
    .run(job, status, startedAt, durationMs, detail ? JSON.stringify(detail) : null, error || null);
}

export function lastSuccessfulRun(job) {
  return getDb()
    .prepare(
      `SELECT * FROM job_runs WHERE job = ? AND status = 'ok'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(job);
}

export function lastRun(job) {
  return getDb()
    .prepare('SELECT * FROM job_runs WHERE job = ? ORDER BY started_at DESC LIMIT 1')
    .get(job);
}
