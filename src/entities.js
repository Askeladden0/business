import { createHash } from 'node:crypto';
import { getDb, parseDbTime } from './db.js';
import { log } from './log.js';
import { fetchEntity, EntityGoneError, EntityNotFoundError } from './brreg.js';
import { normalizeEntity, deletedSnapshot, diffEntities, dedupKey } from './diff.js';

/** Markering i entities.fetch_error for et organisasjonsnummer Brreg ikke kjenner. */
export const IKKE_FUNNET = 'Finnes ikke i Enhetsregisteret';

export function getEntityRow(orgnr) {
  return getDb().prepare('SELECT * FROM entities WHERE orgnr = ?').get(orgnr);
}

export function getSnapshot(orgnr) {
  const row = getEntityRow(orgnr);
  if (!row || !row.snapshot) return null;
  try {
    return JSON.parse(row.snapshot);
  } catch {
    return null;
  }
}

function hashSnapshot(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 32);
}

export function saveSnapshot(orgnr, snapshot, { changed = false, error = null } = {}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO entities (orgnr, navn, snapshot, raw_hash, deleted, last_checked, last_changed, fetch_error)
     VALUES (?, ?, ?, ?, ?, datetime('now'), CASE WHEN ? THEN datetime('now') ELSE NULL END, ?)
     ON CONFLICT(orgnr) DO UPDATE SET
       navn = excluded.navn,
       snapshot = excluded.snapshot,
       raw_hash = excluded.raw_hash,
       deleted = excluded.deleted,
       last_checked = excluded.last_checked,
       last_changed = CASE WHEN ? THEN datetime('now') ELSE entities.last_changed END,
       fetch_error = excluded.fetch_error`,
  ).run(
    orgnr,
    snapshot ? snapshot.navn : null,
    snapshot ? JSON.stringify(snapshot) : null,
    snapshot ? hashSnapshot(snapshot) : null,
    snapshot && snapshot.slettet ? 1 : 0,
    changed ? 1 : 0,
    error,
    changed ? 1 : 0,
  );
}

export function markFetchError(orgnr, message) {
  getDb()
    .prepare(
      `INSERT INTO entities (orgnr, last_checked, fetch_error) VALUES (?, datetime('now'), ?)
       ON CONFLICT(orgnr) DO UPDATE SET last_checked = datetime('now'), fetch_error = excluded.fetch_error`,
    )
    .run(orgnr, String(message).slice(0, 500));
}

/** Lagrer hendelser og returnerer radene som faktisk ble lagt inn (dedupet). */
export function persistEvents(orgnr, navn, events, when = new Date()) {
  if (!events.length) return [];
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO events (orgnr, navn, type, severity, felt, fra_verdi, til_verdi, occurred_at, dedup_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedup_key) DO NOTHING`,
  );
  const inserted = [];
  const tx = db.transaction(() => {
    for (const event of events) {
      const key = dedupKey(orgnr, event, when);
      const result = insert.run(
        orgnr, navn, event.type, event.severity, event.felt,
        event.fra, event.til, when.toISOString(), key,
      );
      if (result.changes > 0) {
        inserted.push({ id: result.lastInsertRowid, orgnr, navn, ...event });
      }
    }
  });
  tx();
  return inserted;
}

/**
 * Henter enheten på nytt fra Brreg, sammenlikner med lagret snapshot og
 * lagrer eventuelle hendelser.
 *
 * @param {object} options
 * @param {boolean} options.emitEvents  false ved første gangs innlegging, slik
 *   at kunden ikke får varsler om historikk de aldri har sett.
 */
export async function refreshEntity(orgnr, { emitEvents = true } = {}) {
  const before = getSnapshot(orgnr);
  let after;

  try {
    const raw = await fetchEntity(orgnr);
    after = normalizeEntity(raw);
    if (!after || !after.orgnr) after = { ...normalizeEntity(raw), orgnr };
  } catch (err) {
    if (err instanceof EntityGoneError) {
      const slettedato = (err.body && (err.body.slettedato || err.body.slettetDato)) || null;
      after = deletedSnapshot(orgnr, before, slettedato);
    } else if (err instanceof EntityNotFoundError) {
      // Ukjent orgnr — ikke en systemfeil, men vi lagrer det så grensesnittet
      // kan vise at nummeret ikke finnes.
      markFetchError(orgnr, IKKE_FUNNET);
      return { ok: false, reason: 'not_found', events: [] };
    } else {
      markFetchError(orgnr, err.message);
      return { ok: false, reason: 'error', error: err, events: [] };
    }
  }

  const events = emitEvents ? diffEntities(before, after) : [];
  const inserted = events.length ? persistEvents(orgnr, after.navn || (before && before.navn), events) : [];
  saveSnapshot(orgnr, after, { changed: inserted.length > 0 });

  if (inserted.length) {
    log.info('registerendringer funnet', {
      orgnr,
      antall: inserted.length,
      typer: inserted.map((e) => e.type),
    });
  }
  return { ok: true, snapshot: after, events: inserted };
}

// Hvor lenge vi stoler på at et organisasjonsnummer ikke finnes. Kort, slik at
// et nyregistrert nummer ikke blir avvist for alltid.
const UKJENT_TTL_MS = 3600_000;

/** True hvis vi nylig har slått opp nummeret og fått vite at det ikke finnes. */
export function isKnownMissing(orgnr) {
  const row = getEntityRow(orgnr);
  if (!row || row.snapshot || row.fetch_error !== IKKE_FUNNET) return false;
  const checked = parseDbTime(row.last_checked);
  if (checked === null) return false;
  return Date.now() - checked < UKJENT_TTL_MS;
}

/**
 * Må denne enheten hentes fra Brreg? Én kilde til sannhet, brukt både av
 * masseimporten som forhåndshenter parallelt og av addWatch.
 */
export function needsFetch(orgnr) {
  const row = getEntityRow(orgnr);
  if (row && row.snapshot) return false;
  return !isKnownMissing(orgnr);
}

/** Organisasjonsnumre som minst én kunde overvåker og som mangler snapshot. */
export function orgnrsMissingSnapshot(limit = 200) {
  return getDb()
    .prepare(
      `SELECT DISTINCT w.orgnr FROM watches w
       LEFT JOIN entities e ON e.orgnr = w.orgnr
       WHERE e.orgnr IS NULL OR e.snapshot IS NULL
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => row.orgnr);
}
