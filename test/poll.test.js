import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWorld, ORGNR } from './helpers/app.js';
import { getDb, kvGet } from '../src/db.js';
import { ensureAccount, updateAccount } from '../src/accounts.js';
import { addWatch } from '../src/watches.js';
import { pollBrreg } from '../src/jobs.js';
import { outbox } from '../src/mailer.js';
import { getSnapshot } from '../src/entities.js';

async function world() {
  const w = await setupWorld();
  const account = ensureAccount('kunde@test.no');
  updateAccount(account.id, { plan: 'solo', alert_level: 'alle', delivery_mode: 'straks' });
  return { ...w, account: getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(account.id) };
}

test('første kjøring setter markør uten å behandle historikk', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  w.brreg.pushUpdate(ORGNR.a);
  w.brreg.pushUpdate(ORGNR.b);

  const result = await pollBrreg();
  assert.equal(result.bootstrapped, true);
  assert.equal(result.hendelser, 0, 'ingen varsler fra historikk ved oppstart');
  assert.ok(Number(kvGet('brreg_oppdateringsid_enheter')) > 0, 'markør skal være satt');
});

test('varsler kun om organisasjonsnumre noen faktisk følger', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  w.brreg.setEntity(ORGNR.b);
  await addWatch(w.account, ORGNR.a);
  await pollBrreg(); // setter markør

  // To selskaper endrer seg i registeret, men vi følger bare det ene.
  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.patchEntity(ORGNR.b, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  w.brreg.pushUpdate(ORGNR.b);

  const result = await pollBrreg();
  assert.equal(result.endretIRegisteret, 2, 'begge sees i endringsstrømmen');
  assert.equal(result.overvaaket, 1, 'bare én hentes');
  assert.equal(result.hendelser, 1);

  const events = getDb().prepare('SELECT * FROM events').all();
  assert.equal(events.length, 1);
  assert.equal(events[0].orgnr, ORGNR.a);
  assert.equal(events[0].type, 'KONKURS');
});

test('kostnaden skalerer med endringer, ikke med antall kunder', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  // Femti kunder følger det samme selskapet.
  for (let i = 0; i < 50; i += 1) {
    const account = ensureAccount(`kunde${i}@test.no`);
    updateAccount(account.id, { plan: 'solo' });
    await addWatch(getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(account.id), ORGNR.a);
  }
  await pollBrreg();
  const before = w.brreg.state.requests.length;

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  const kall = w.brreg.state.requests.length - before;
  assert.ok(kall <= 3, `forventet få kall mot Brreg, fikk ${kall}`);

  // Én hendelse i basen, men én levering per kunde som følger selskapet.
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 50);
});

test('sletting fra registeret oppdages og varsles', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  await addWatch(w.account, ORGNR.a);
  await pollBrreg();

  w.brreg.markGone(ORGNR.a, '2026-08-20');
  w.brreg.pushUpdate(ORGNR.a, { endringstype: 'Sletting' });
  const result = await pollBrreg();

  assert.equal(result.hendelser, 1);
  const event = getDb().prepare('SELECT * FROM events').get();
  assert.equal(event.type, 'SLETTET');
  assert.equal(event.til_verdi, '2026-08-20');
  assert.equal(getSnapshot(ORGNR.a).slettet, true);
});

test('samme endring to ganger gir bare én hendelse', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  await addWatch(w.account, ORGNR.a);
  await pollBrreg();

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  // Registeret melder endring på nytt uten at noe faktisk er annerledes.
  w.brreg.pushUpdate(ORGNR.a);
  const second = await pollBrreg();

  assert.equal(second.hendelser, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

test('nytt selskap i vaktlisten gir ikke varsler for historikk', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a, { konkurs: true, navn: 'ALLEREDE KONKURS AS' });
  await addWatch(w.account, ORGNR.a);
  const result = await pollBrreg();

  assert.equal(result.hendelser, 0, 'eksisterende tilstand er ikke en endring');
  assert.equal(getSnapshot(ORGNR.a).konkurs, true, 'men tilstanden skal være lagret');
});

test('en enhet som ikke kan hentes stopper ikke resten', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  w.brreg.setEntity(ORGNR.b);
  await addWatch(w.account, ORGNR.a);
  await addWatch(w.account, ORGNR.b);
  await pollBrreg();

  // ORGNR.b forsvinner helt fra det falske API-et (404), ORGNR.a endrer seg.
  w.brreg.state.entities.delete(ORGNR.b);
  w.brreg.patchEntity(ORGNR.a, { navn: 'NYTT NAVN AS' });
  w.brreg.pushUpdate(ORGNR.a);
  w.brreg.pushUpdate(ORGNR.b);

  const result = await pollBrreg();
  assert.equal(result.failed, 1);
  assert.equal(result.hendelser, 1);
  assert.equal(getDb().prepare('SELECT type FROM events').get().type, 'NAVN_ENDRET');
});

test('markøren flyttes fremover, så samme oppdatering ikke behandles igjen', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  await addWatch(w.account, ORGNR.a);
  await pollBrreg();

  w.brreg.patchEntity(ORGNR.a, { navn: 'STEG EN AS' });
  const id = w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();
  assert.equal(Number(kvGet('brreg_oppdateringsid_enheter')), id);

  // Ingen nye oppdateringer: kjøringen skal ikke hente enheten på nytt.
  const before = w.brreg.state.requests.length;
  const result = await pollBrreg();
  assert.equal(result.hendelser, 0);
  assert.equal(result.overvaaket, 0);
  assert.ok(w.brreg.state.requests.length - before <= 2);
});

test('varsel-e-post sendes til kunden ved endring', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a, { navn: 'VARSEL AS' });
  await addWatch(w.account, ORGNR.a);
  await pollBrreg();
  outbox().length = 0;

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  assert.equal(outbox().length, 1);
  const mail = outbox()[0];
  assert.deepEqual(mail.to, ['kunde@test.no']);
  assert.match(mail.subject, /kritisk/i);
  assert.match(mail.text, /VARSEL AS/);
  assert.match(mail.text, /Konkurs er registrert/);
});

test('flere endringer i samme runde blir én e-post', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  w.brreg.setEntity(ORGNR.b);
  await addWatch(w.account, ORGNR.a);
  await addWatch(w.account, ORGNR.b);
  await pollBrreg();
  outbox().length = 0;

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.patchEntity(ORGNR.b, { navn: 'ANNET NAVN AS', antallAnsatte: 1 });
  w.brreg.pushUpdate(ORGNR.a);
  w.brreg.pushUpdate(ORGNR.b);
  await pollBrreg();

  assert.equal(outbox().length, 1, 'én e-post per runde, ikke én per hendelse');
  assert.match(outbox()[0].text, /Konkurs er registrert/);
  assert.match(outbox()[0].text, /Navn endret/);
});

test('feil mot Brreg gir tydelig feil og ingen tapt markør', async (t) => {
  const w = await world();
  t.after(() => w.teardown());

  w.brreg.setEntity(ORGNR.a);
  await addWatch(w.account, ORGNR.a);
  await pollBrreg();
  const cursor = kvGet('brreg_oppdateringsid_enheter');

  w.brreg.state.failNext = 1;
  await assert.rejects(() => pollBrreg(), /Brreg svarte 503/);
  assert.equal(kvGet('brreg_oppdateringsid_enheter'), cursor, 'markøren skal ikke flyttes ved feil');
});
