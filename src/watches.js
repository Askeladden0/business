import { getDb } from './db.js';
import { isValidOrgnr, normalizeOrgnr } from './orgnr.js';
import { effectivePlan } from './plans.js';
import { getEntityRow, refreshEntity, isKnownMissing, needsFetch } from './entities.js';

const UKJENT_MELDING = 'Fant ikke dette organisasjonsnummeret i Enhetsregisteret';

export function listWatches(accountId) {
  return getDb()
    .prepare(
      `SELECT w.*, e.navn AS entity_navn, e.snapshot, e.deleted, e.last_checked, e.fetch_error
       FROM watches w
       LEFT JOIN entities e ON e.orgnr = w.orgnr
       WHERE w.account_id = ?
       ORDER BY COALESCE(e.navn, w.orgnr)`,
    )
    .all(accountId)
    .map((row) => {
      let snapshot = null;
      if (row.snapshot) {
        try {
          snapshot = JSON.parse(row.snapshot);
        } catch {
          snapshot = null;
        }
      }
      return { ...row, snapshot };
    });
}

export function countWatches(accountId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM watches WHERE account_id = ?')
    .get(accountId).n;
}

export function hasWatch(accountId, orgnr) {
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM watches WHERE account_id = ? AND orgnr = ?')
      .get(accountId, normalizeOrgnr(orgnr)),
  );
}

/**
 * Legger til én vakt. Returnerer et resultatobjekt i stedet for å kaste, fordi
 * dette kalles i løkke fra CSV-import der delvise feil er normalt.
 */
export async function addWatch(account, rawOrgnr, { label = null, fetchNow = true } = {}) {
  const orgnr = normalizeOrgnr(rawOrgnr);
  if (!isValidOrgnr(orgnr)) {
    return { ok: false, orgnr, reason: 'ugyldig', melding: 'Ikke et gyldig organisasjonsnummer' };
  }
  if (hasWatch(account.id, orgnr)) {
    return { ok: false, orgnr, reason: 'duplikat', melding: 'Følges allerede' };
  }

  const plan = effectivePlan(account);
  if (countWatches(account.id) >= plan.maxWatches) {
    return {
      ok: false,
      orgnr,
      reason: 'plangrense',
      melding: `Planen «${plan.navn}» har plass til ${plan.maxWatches} selskaper`,
    };
  }

  // Hent enheten før vi lagrer vakten, slik at et ukjent organisasjonsnummer
  // avvises med en gang i stedet for å ligge som en død rad.
  if (isKnownMissing(orgnr)) {
    return { ok: false, orgnr, reason: 'ukjent', melding: UKJENT_MELDING };
  }

  if (fetchNow && needsFetch(orgnr)) {
    const result = await refreshEntity(orgnr, { emitEvents: false });
    if (!result.ok && result.reason === 'not_found') {
      return { ok: false, orgnr, reason: 'ukjent', melding: UKJENT_MELDING };
    }
  }

  getDb()
    .prepare('INSERT INTO watches (account_id, orgnr, label) VALUES (?, ?, ?)')
    .run(account.id, orgnr, label || null);

  const entity = getEntityRow(orgnr);
  return { ok: true, orgnr, navn: entity ? entity.navn : null };
}

export function removeWatch(accountId, orgnr) {
  const result = getDb()
    .prepare('DELETE FROM watches WHERE account_id = ? AND orgnr = ?')
    .run(accountId, normalizeOrgnr(orgnr));
  return result.changes > 0;
}

/** Av kandidatene: hvilke overvåkes av minst én kunde? Kjernen i fan-out. */
export function watchedAmong(orgnrs) {
  if (!orgnrs.length) return [];
  const db = getDb();
  const found = new Set();
  // SQLite tåler maks 999 variabler per spørring som standard; del opp.
  for (let i = 0; i < orgnrs.length; i += 500) {
    const chunk = orgnrs.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT DISTINCT orgnr FROM watches WHERE orgnr IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) found.add(row.orgnr);
  }
  return [...found];
}

/** Kontoer som følger et gitt organisasjonsnummer. */
export function accountsWatching(orgnr) {
  return getDb()
    .prepare(
      `SELECT a.* FROM accounts a
       JOIN watches w ON w.account_id = a.id
       WHERE w.orgnr = ?`,
    )
    .all(orgnr);
}
