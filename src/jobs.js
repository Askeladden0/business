import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { getDb, kvGet, kvSet, recordJobRun, lastSuccessfulRun, parseDbTime } from './db.js';
import { fetchUpdatePage, mapWithConcurrency } from './brreg.js';
import { refreshEntity, orgnrsMissingSnapshot } from './entities.js';
import { watchedAmong } from './watches.js';
import { fanOut, flushDeliveries, stuckDeliveries } from './notify.js';
import { opsAlert, clearAlert } from './alerts.js';
import { purgeExpiredAuth } from './auth.js';

const CURSOR_KEY = 'brreg_oppdateringsid_enheter';

export { parseDbTime };

export function osloNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

/** Kjører en jobb med tidtaking, logging og feilregistrering i job_runs. */
export async function runJob(name, fn) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const detail = await fn();
    recordJobRun({ job: name, status: 'ok', startedAt, durationMs: Date.now() - t0, detail });
    log.info('jobb ferdig', { job: name, ms: Date.now() - t0, ...(detail || {}) });
    return { ok: true, detail };
  } catch (err) {
    recordJobRun({
      job: name, status: 'error', startedAt, durationMs: Date.now() - t0, error: err.message,
    });
    log.error('jobb feilet', { job: name, err });
    await opsAlert(
      `job:${name}`,
      `Jobben «${name}» feilet`,
      `${err.message}\n\n${err.stack || ''}`,
    );
    return { ok: false, error: err };
  }
}

/**
 * Hovedsløyfen. Henter Brregs globale endringsstrøm én gang, krysser den mot
 * alle kunders vaktlister samtidig, og henter kun de enhetene noen faktisk
 * følger. Kostnaden er derfor tilnærmet uavhengig av antall kunder.
 */
export async function pollBrreg() {
  let cursor = kvGet(CURSOR_KEY);
  let bootstrapped = false;

  if (!cursor) {
    // Første kjøring: finn en startmarkør fra i går, uten å behandle historikk.
    const since = new Date(Date.now() - 24 * 3600_000).toISOString().replace(/\.\d+Z$/, '.000Z');
    const first = await fetchUpdatePage({ dato: since, size: 1 });
    const maxId = first.items.reduce((max, item) => Math.max(max, item.oppdateringsid || 0), 0);
    cursor = maxId || 0;
    kvSet(CURSOR_KEY, cursor);
    bootstrapped = true;
    log.info('satte startmarkør for Brreg-strømmen', { cursor });
  }

  const changed = new Set();
  let pages = 0;
  let highest = Number(cursor);
  let scanned = 0;

  if (!bootstrapped) {
    for (; pages < config.brreg.maxPagesPerRun; pages += 1) {
      const { items } = await fetchUpdatePage({
        oppdateringsid: highest,
        size: config.brreg.pageSize,
      });
      // Ingen elementer, eller kun elementer vi allerede har sett: vi er ajour.
      const fresh = items.filter((item) => (item.oppdateringsid || 0) > Number(cursor));
      scanned += items.length;
      if (!items.length) break;

      for (const item of items) {
        highest = Math.max(highest, item.oppdateringsid || 0);
        if ((item.oppdateringsid || 0) > Number(cursor)) changed.add(item.organisasjonsnummer);
      }
      if (!fresh.length) break;
      if (items.length < config.brreg.pageSize) break;
    }
  }

  // Enheter noen følger, men som vi ennå ikke har et snapshot for.
  const backfill = orgnrsMissingSnapshot(200);
  const watched = watchedAmong([...changed]);
  const targets = [...new Set([...watched, ...backfill])];

  let refreshed = 0;
  let failed = 0;
  const newEvents = [];

  const results = await mapWithConcurrency(targets, config.brreg.concurrency, async (orgnr) => {
    // Backfill skal ikke lage hendelser — kunden har ikke sett en "før"-tilstand.
    const emitEvents = !backfill.includes(orgnr);
    return refreshEntity(orgnr, { emitEvents });
  });

  for (const result of results) {
    if (!result) continue;
    if (result.ok && result.value && result.value.ok) {
      refreshed += 1;
      newEvents.push(...result.value.events);
    } else {
      failed += 1;
    }
  }

  const fannedOut = fanOut(newEvents);
  kvSet(CURSOR_KEY, highest);

  if (newEvents.length) await flushDeliveries({ modes: ['straks'] });

  return {
    bootstrapped,
    pages,
    scanned,
    endretIRegisteret: changed.size,
    overvaaket: watched.length,
    backfill: backfill.length,
    refreshed,
    failed,
    hendelser: newEvents.length,
    leveringer: fannedOut.deliveries,
  };
}

/** Daglig oppsummering til kontoer som har valgt det (og til gratisplanen). */
export async function sendDailyDigest() {
  const result = await flushDeliveries({ modes: ['daglig'] });
  return result;
}

/**
 * Varsler eieren kun når noe faktisk er galt: pollejobben har ikke lyktes på
 * lenge, eller leveringer sitter fast. Ellers er den helt stille.
 */
export async function healthWatchdog() {
  const problems = [];
  const last = lastSuccessfulRun('poll');
  const maxAgeMs = config.ops.stalePollHours * 3600_000;

  if (!last) {
    // Rett etter deploy er dette normalt; vent til første intervall er over.
    const uptimeMs = process.uptime() * 1000;
    if (uptimeMs > maxAgeMs) problems.push('Pollejobben har aldri lyktes siden oppstart.');
  } else {
    const startedMs = parseDbTime(last.started_at);
    const age = startedMs === null ? Number.POSITIVE_INFINITY : Date.now() - startedMs;
    if (age > maxAgeMs) {
      problems.push(
        Number.isFinite(age)
          ? `Siste vellykkede polling var ${Math.round(age / 3600_000)} timer siden (grense: ${config.ops.stalePollHours} t).`
          : 'Kunne ikke tolke tidspunktet for siste vellykkede polling.',
      );
    }
  }

  const stuck = stuckDeliveries();
  if (stuck > 0) problems.push(`${stuck} varsler har feilet 5 ganger og sendes ikke.`);

  if (problems.length) {
    await opsAlert('watchdog', 'Noe er galt med driften', problems.join('\n'));
    return { ok: false, problems };
  }
  clearAlert('watchdog');
  clearAlert('job:poll');
  return { ok: true, problems: [] };
}

/** Rydder gamle rader så databasen holder seg liten uten tilsyn. */
export async function cleanup() {
  const db = getDb();
  const auth = purgeExpiredAuth();
  const events = db
    .prepare("DELETE FROM events WHERE occurred_at < datetime('now', '-400 days')")
    .run();
  const jobs = db
    .prepare("DELETE FROM job_runs WHERE started_at < datetime('now', '-30 days')")
    .run();
  const mail = db
    .prepare("DELETE FROM mail_log WHERE created_at < datetime('now', '-90 days')")
    .run();
  const stripe = db
    .prepare("DELETE FROM stripe_events WHERE handled_at < datetime('now', '-90 days')")
    .run();
  return {
    sesjoner: auth.sessions,
    engangslenker: auth.magicLinks,
    hendelser: events.changes,
    jobbrader: jobs.changes,
    epostlogg: mail.changes,
    stripehendelser: stripe.changes,
  };
}

/**
 * Sikkerhetskopi til disk. Beholder 7 dagers rullering. Det viktigste for
 * gjenoppretting — kontoer og vaktlister — sendes i tillegg som CSV på e-post
 * av weeklyBackupEmail, slik at det finnes en kopi utenfor serveren.
 */
export async function backupDatabase() {
  if (config.databasePath === ':memory:') return { skipped: true };
  mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const target = join(config.backupDir, `registervakt-${stamp}.db`);
  getDb().prepare('VACUUM INTO ?').run(target);

  let removed = 0;
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const file of readdirSync(config.backupDir)) {
    if (!file.startsWith('registervakt-') || !file.endsWith('.db')) continue;
    const full = join(config.backupDir, file);
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      removed += 1;
    }
  }
  return { fil: target, slettet: removed, bytes: statSync(target).size };
}

/** Kontoer og vaktlister som CSV, på e-post. Sikkerhetskopi utenfor serveren. */
export function accountsCsv() {
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.email, a.plan, a.status, a.stripe_customer_id, a.created_at,
              COALESCE(GROUP_CONCAT(w.orgnr, ' '), '') AS orgnr
       FROM accounts a LEFT JOIN watches w ON w.account_id = a.id
       GROUP BY a.id ORDER BY a.id`,
    )
    .all();
  const header = 'id,epost,plan,status,stripe_customer_id,opprettet,orgnr';
  const body = rows
    .map((row) =>
      [row.id, row.email, row.plan, row.status, row.stripe_customer_id || '', row.created_at, row.orgnr]
        .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
        .join(','),
    )
    .join('\n');
  return `${header}\n${body}\n`;
}

/**
 * Ukentlig sikkerhetskopi utenfor serveren: kontoer og vaktlister som CSV rett
 * i innboksen. Databasen kan gjenskapes fra Brreg, men kunderelasjonene kan
 * ikke — så det er dem vi tar vare på et annet sted enn på maskinen.
 */
export async function weeklyBackupEmail() {
  if (!config.ops.alertEmail) return { skipped: 'ingen ALERT_EMAIL' };
  const { sendMail } = await import('./mailer.js');
  const { escapeHtml } = await import('./alerts.js');
  const csv = accountsCsv();
  const antall = Math.max(0, csv.trim().split('\n').length - 1);
  const trimmed = csv.length > 200_000 ? `${csv.slice(0, 200_000)}\n... (avkortet)` : csv;
  await sendMail({
    to: config.ops.alertEmail,
    subject: `[${config.brand.name}] Ukentlig sikkerhetskopi — ${antall} kontoer`,
    text: `Kontoer og vaktlister per ${new Date().toISOString()}\n\n${trimmed}`,
    html: `<p>Kontoer og vaktlister per ${new Date().toISOString()}</p><pre style="font:12px ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(trimmed)}</pre>`,
    kind: 'backup',
  });
  return { antall, bytes: csv.length };
}
