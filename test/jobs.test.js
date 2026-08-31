import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWorld, ORGNR } from './helpers/app.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { ensureAccount, updateAccount } from '../src/accounts.js';
import { addWatch } from '../src/watches.js';
import { healthWatchdog, cleanup, runJob, osloNow, parseDbTime, accountsCsv } from '../src/jobs.js';
import { opsAlert, clearAlert } from '../src/alerts.js';
import { outbox } from '../src/mailer.js';
import { purgeExpiredAuth, createMagicLink, createSession } from '../src/auth.js';

function recordPoll(status, agoHours) {
  getDb()
    .prepare(
      `INSERT INTO job_runs (job, status, started_at, finished_at, duration_ms)
       VALUES ('poll', ?, ?, ?, 5)`,
    )
    .run(status, new Date(Date.now() - agoHours * 3600_000).toISOString(), new Date().toISOString());
}

test('vakthunden er stille når alt er i orden', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  recordPoll('ok', 0.5);
  outbox().length = 0;

  const result = await healthWatchdog();
  assert.equal(result.ok, true);
  assert.equal(outbox().length, 0, 'ingen e-post når alt fungerer');
});

test('vakthunden varsler når pollejobben er for gammel', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  recordPoll('ok', 48);
  outbox().length = 0;

  const result = await healthWatchdog();
  assert.equal(result.ok, false);
  assert.equal(outbox().length, 1);
  assert.deepEqual(outbox()[0].to, ['ops@test.no']);
  assert.match(outbox()[0].subject, /Noe er galt med driften/);
  assert.match(outbox()[0].text, /48 timer siden/);
});

test('samme feil varsles bare én gang innenfor nedkjølingen', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  recordPoll('ok', 48);
  outbox().length = 0;

  await healthWatchdog();
  await healthWatchdog();
  await healthWatchdog();
  assert.equal(outbox().length, 1, 'én vedvarende feil skal gi én e-post, ikke tre');

  const state = getDb().prepare('SELECT * FROM alert_state').get();
  assert.ok(state.count >= 3, 'undertrykte gjentakelser skal telles');
});

test('varsling starter på nytt etter at feilen er rettet', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  recordPoll('ok', 48);
  outbox().length = 0;
  await healthWatchdog();
  assert.equal(outbox().length, 1);

  // Jobben lykkes igjen: vakthunden er fornøyd og nullstiller nedkjølingen.
  recordPoll('ok', 0.1);
  await healthWatchdog();
  assert.equal(outbox().length, 1, 'ingen ny e-post når feilen er borte');

  // Ny feil: den ferske kjøringen finnes ikke lenger, bare en gammel.
  getDb().prepare("DELETE FROM job_runs WHERE job = 'poll'").run();
  recordPoll('ok', 72);
  await healthWatchdog();
  assert.equal(outbox().length, 2, 'ny feil skal varsles på nytt etter at nedkjølingen er nullstilt');
});

test('vakthunden varsler om fastlåste leveringer', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  recordPoll('ok', 0.1);

  const account = ensureAccount('fast@test.no');
  getDb()
    .prepare(
      `INSERT INTO events (orgnr, navn, type, severity, dedup_key, occurred_at)
       VALUES (?, 'X', 'KONKURS', 'kritisk', 'nokkel1', datetime('now'))`,
    )
    .run(ORGNR.a);
  const eventId = getDb().prepare('SELECT id FROM events').get().id;
  getDb()
    .prepare(
      `INSERT INTO deliveries (account_id, event_id, status, attempts)
       VALUES (?, ?, 'pending', 5)`,
    )
    .run(account.id, eventId);

  outbox().length = 0;
  const result = await healthWatchdog();
  assert.equal(result.ok, false);
  assert.match(outbox()[0].text, /feilet 5 ganger/);
});

test('en feilende jobb varsler eieren', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  outbox().length = 0;

  const result = await runJob('testjobb', async () => {
    throw new Error('noe gikk fryktelig galt');
  });

  assert.equal(result.ok, false);
  assert.equal(outbox().length, 1);
  assert.match(outbox()[0].subject, /testjobb.*feilet/);
  assert.match(outbox()[0].text, /noe gikk fryktelig galt/);

  const run = getDb().prepare("SELECT * FROM job_runs WHERE job = 'testjobb'").get();
  assert.equal(run.status, 'error');
});

test('en vellykket jobb registreres med varighet', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const result = await runJob('godjobb', async () => ({ antall: 3 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.detail, { antall: 3 });

  const run = getDb().prepare("SELECT * FROM job_runs WHERE job = 'godjobb'").get();
  assert.equal(run.status, 'ok');
  assert.ok(run.duration_ms >= 0);
  assert.match(run.detail, /antall/);
});

test('ops-varsel uten ALERT_EMAIL krasjer ikke', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  const original = config.ops.alertEmail;
  config.ops.alertEmail = '';
  const result = await opsAlert('uten-epost', 'Test', 'kropp');
  assert.equal(result.sent, false);
  config.ops.alertEmail = original;
});

test('opprydding sletter utløpte sesjoner og gamle rader', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const account = ensureAccount('rydd@test.no');
  createSession(account.id);
  getDb()
    .prepare("UPDATE sessions SET expires_at = datetime('now', '-1 day')")
    .run();
  createMagicLink('rydd@test.no');
  getDb().prepare("UPDATE magic_links SET expires_at = datetime('now', '-5 days')").run();

  getDb()
    .prepare(
      `INSERT INTO events (orgnr, navn, type, severity, dedup_key, occurred_at)
       VALUES (?, 'Gammel', 'KONKURS', 'kritisk', 'gammel', datetime('now', '-500 days'))`,
    )
    .run(ORGNR.a);
  getDb()
    .prepare(
      `INSERT INTO events (orgnr, navn, type, severity, dedup_key, occurred_at)
       VALUES (?, 'Ny', 'KONKURS', 'kritisk', 'ny', datetime('now'))`,
    )
    .run(ORGNR.b);

  const result = await cleanup();
  assert.equal(result.sesjoner, 1);
  assert.equal(result.engangslenker, 1);
  assert.equal(result.hendelser, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM events').get().n, 1, 'ferske hendelser beholdes');
});

test('gyldige sesjoner overlever oppryddingen', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  const account = ensureAccount('beholdes@test.no');
  createSession(account.id);
  const result = purgeExpiredAuth();
  assert.equal(result.sessions, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('sikkerhetskopi-CSV inneholder kontoer og vaktlister', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const account = ensureAccount('csv@test.no');
  updateAccount(account.id, { plan: 'solo' });
  w.brreg.setEntity(ORGNR.a);
  w.brreg.setEntity(ORGNR.b);
  const fresh = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  await addWatch(fresh, ORGNR.a);
  await addWatch(fresh, ORGNR.b);

  const csv = accountsCsv();
  assert.match(csv, /^id,epost,plan,status/);
  assert.match(csv, /csv@test\.no/);
  assert.match(csv, new RegExp(ORGNR.a));
  assert.match(csv, new RegExp(ORGNR.b));
});

test('tidshåndtering i Oslo-tid er konsistent', () => {
  const sommer = osloNow(new Date('2026-07-01T10:00:00Z'));
  assert.equal(sommer.date, '2026-07-01');
  assert.equal(sommer.hour, 12, 'CEST er UTC+2');

  const vinter = osloNow(new Date('2026-01-15T10:00:00Z'));
  assert.equal(vinter.hour, 11, 'CET er UTC+1');

  // Midnatt i Oslo tilhører forrige UTC-dag.
  const natt = osloNow(new Date('2026-07-01T23:30:00Z'));
  assert.equal(natt.date, '2026-07-02');
});

test('tidsstempler fra basen tolkes uansett format', () => {
  const iso = parseDbTime('2026-08-31T10:00:00.000Z');
  const sqlite = parseDbTime('2026-08-31 10:00:00');
  assert.equal(iso, sqlite, 'begge formater skal gi samme tidspunkt i UTC');
  assert.equal(parseDbTime(null), null);
  assert.equal(parseDbTime('tull'), null);
});
