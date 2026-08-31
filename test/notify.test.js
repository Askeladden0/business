import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWorld, ORGNR } from './helpers/app.js';
import { getDb } from '../src/db.js';
import { ensureAccount, updateAccount, recipientsFor } from '../src/accounts.js';
import { addWatch } from '../src/watches.js';
import { pollBrreg, sendDailyDigest } from '../src/jobs.js';
import { flushDeliveries } from '../src/notify.js';
import { outbox } from '../src/mailer.js';
import { effectivePlan, effectiveDeliveryMode } from '../src/plans.js';

function reload(id) {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

async function kunde(email, fields = {}) {
  const account = ensureAccount(email);
  updateAccount(account.id, { plan: 'solo', alert_level: 'viktig', delivery_mode: 'straks', ...fields });
  return reload(account.id);
}

test('varslingsnivå styrer hvem som får e-post', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const kunKritisk = await kunde('kritisk@test.no', { alert_level: 'kritisk' });
  const alt = await kunde('alt@test.no', { alert_level: 'alle' });

  w.brreg.setEntity(ORGNR.a);
  await addWatch(kunKritisk, ORGNR.a);
  await addWatch(alt, ORGNR.a);
  await pollBrreg();
  outbox().length = 0;

  // Adresseendring er «info» — bare kunden som vil ha alt skal varsles.
  w.brreg.patchEntity(ORGNR.a, {
    forretningsadresse: { adresse: ['Nygata 9'], postnummer: '5003', poststed: 'BERGEN', kommune: 'BERGEN', land: 'Norge' },
  });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  const mottakere = outbox().flatMap((mail) => mail.to);
  assert.deepEqual(mottakere, ['alt@test.no']);
});

test('kritisk hendelse når alle nivåer', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const kunKritisk = await kunde('kritisk@test.no', { alert_level: 'kritisk' });
  const viktig = await kunde('viktig@test.no', { alert_level: 'viktig' });
  const alt = await kunde('alt@test.no', { alert_level: 'alle' });

  w.brreg.setEntity(ORGNR.a);
  for (const account of [kunKritisk, viktig, alt]) await addWatch(account, ORGNR.a);
  await pollBrreg();
  outbox().length = 0;

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  const mottakere = outbox().flatMap((mail) => mail.to).sort();
  assert.deepEqual(mottakere, ['alt@test.no', 'kritisk@test.no', 'viktig@test.no']);
});

test('gratisplanen får daglig oppsummering, ikke varsel med én gang', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  // Selv om kontoen ber om «straks», tvinger planen daglig.
  const gratis = await kunde('gratis@test.no', { plan: 'gratis', delivery_mode: 'straks' });
  assert.equal(effectiveDeliveryMode(gratis), 'daglig');

  w.brreg.setEntity(ORGNR.a);
  await addWatch(gratis, ORGNR.a);
  await pollBrreg();
  outbox().length = 0;

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();
  assert.equal(outbox().length, 0, 'ingen umiddelbar e-post til gratisplanen');

  await sendDailyDigest();
  assert.equal(outbox().length, 1);
  assert.match(outbox()[0].subject, /kritisk/i);
  assert.match(outbox()[0].text, /Daglig oppsummering|Konkurs/);
});

test('daglig oppsummering samler flere hendelser i én e-post', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const account = await kunde('daglig@test.no', { delivery_mode: 'daglig', alert_level: 'alle' });
  w.brreg.setEntity(ORGNR.a);
  w.brreg.setEntity(ORGNR.b);
  await addWatch(account, ORGNR.a);
  await addWatch(account, ORGNR.b);
  await pollBrreg();
  outbox().length = 0;

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  w.brreg.patchEntity(ORGNR.b, { navn: 'ENDRET AS' });
  w.brreg.pushUpdate(ORGNR.b);
  await pollBrreg();

  assert.equal(outbox().length, 0);
  await sendDailyDigest();
  assert.equal(outbox().length, 1, 'to runder skal bli én daglig e-post');
  assert.match(outbox()[0].text, /Konkurs er registrert/);
  assert.match(outbox()[0].text, /Navn endret/);
});

test('selskaper utenfor plangrensen varsles ikke', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const gratis = await kunde('grense@test.no', { plan: 'gratis' });
  const plan = effectivePlan(gratis);
  assert.equal(plan.maxWatches, 3);

  const alle = [ORGNR.a, ORGNR.b, ORGNR.c, ORGNR.d];
  for (const orgnr of alle) w.brreg.setEntity(orgnr);
  for (const orgnr of alle.slice(0, 3)) {
    assert.equal((await addWatch(gratis, orgnr)).ok, true);
  }
  // Den fjerde avvises av plangrensen allerede ved innlegging.
  const fjerde = await addWatch(gratis, ORGNR.d);
  assert.equal(fjerde.ok, false);
  assert.equal(fjerde.reason, 'plangrense');
});

test('nedgradering slutter å varsle, men sletter ikke vaktlisten', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  let account = await kunde('nedgradert@test.no', { plan: 'solo', alert_level: 'kritisk' });
  const alle = [ORGNR.a, ORGNR.b, ORGNR.c, ORGNR.d];
  for (const orgnr of alle) {
    w.brreg.setEntity(orgnr);
    await addWatch(account, orgnr);
  }
  await pollBrreg();

  // Abonnementet sies opp: planen faller til gratis (3 selskaper).
  updateAccount(account.id, { plan: 'gratis', status: 'canceled' });
  account = reload(account.id);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS n FROM watches WHERE account_id = ?').get(account.id).n,
    4,
    'vaktlisten skal beholdes',
  );

  outbox().length = 0;
  // Det fjerde selskapet — utenfor grensen — går konkurs.
  w.brreg.patchEntity(ORGNR.d, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.d);
  await pollBrreg();
  await sendDailyDigest();

  assert.equal(outbox().length, 0, 'ingen varsel for selskap utenfor plangrensen');
  const skipped = getDb()
    .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'skipped'")
    .get().n;
  assert.ok(skipped >= 1, 'leveringen skal markeres som hoppet over, ikke bli liggende');
});

test('flere mottakere begrenses av planen', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const solo = await kunde('solo@test.no', {
    plan: 'solo',
    extra_recipients: 'en@test.no, to@test.no, tre@test.no, fire@test.no',
  });
  // Solo tillater to i tillegg til kontoens egen adresse.
  assert.deepEqual(recipientsFor(solo), ['solo@test.no', 'en@test.no', 'to@test.no']);

  const gratis = await kunde('gratis2@test.no', { plan: 'gratis', extra_recipients: 'en@test.no' });
  assert.deepEqual(recipientsFor(gratis), ['gratis2@test.no']);
});

test('ugyldige og dupliserte mottakere filtreres bort', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());
  const account = await kunde('sjef@test.no', {
    plan: 'byraa',
    extra_recipients: 'sjef@test.no, ikke-en-epost, gyldig@test.no, gyldig@test.no',
  });
  assert.deepEqual(recipientsFor(account), ['sjef@test.no', 'gyldig@test.no']);
});

test('e-postfeil mister ikke varselet — det prøves igjen', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const account = await kunde('retry@test.no');
  w.brreg.setEntity(ORGNR.a);
  await addWatch(account, ORGNR.a);
  await pollBrreg();

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);

  // Simuler at e-postleverandøren er nede under første forsøk.
  const { config } = await import('../src/config.js');
  const original = config.mail.provider;
  config.mail.provider = 'resend';
  config.mail.resendApiKey = '';
  await pollBrreg();
  config.mail.provider = original;

  const pending = getDb()
    .prepare("SELECT * FROM deliveries WHERE status = 'pending'")
    .all();
  assert.equal(pending.length, 1, 'leveringen skal fortsatt ligge i kø');
  assert.equal(pending[0].attempts, 1);

  outbox().length = 0;
  await flushDeliveries({ modes: ['straks'] });
  assert.equal(outbox().length, 1, 'nytt forsøk skal lykkes');
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent'").get().n,
    1,
  );
});

test('webhook sendes i tillegg til e-post', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const mottatt = [];
  const { createServer } = await import('node:http');
  const hook = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      mottatt.push({ body, signatur: req.headers['x-registervakt-signature'] });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => hook.close(resolve)));
  // Webhook-URL må normalt være https; vi kaller postWebhook direkte i testen.
  const url = `http://127.0.0.1:${hook.address().port}/hook`;

  const account = await kunde('hook@test.no', {
    webhook_url: url, webhook_kind: 'json', webhook_secret: 'hemmelig',
  });
  w.brreg.setEntity(ORGNR.a, { navn: 'HOOK AS' });
  await addWatch(account, ORGNR.a);
  await pollBrreg();

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  assert.equal(mottatt.length, 1);
  const payload = JSON.parse(mottatt[0].body);
  assert.equal(payload.hendelser[0].type, 'KONKURS');
  assert.equal(payload.hendelser[0].navn, 'HOOK AS');
  assert.match(mottatt[0].signatur, /^sha256=[0-9a-f]{64}$/);
});

test('ødelagt webhook stopper ikke e-posten', async (t) => {
  const w = await setupWorld();
  t.after(() => w.teardown());

  const account = await kunde('daarlighook@test.no', {
    webhook_url: 'http://127.0.0.1:1/finnes-ikke', webhook_kind: 'slack',
  });
  w.brreg.setEntity(ORGNR.a);
  await addWatch(account, ORGNR.a);
  await pollBrreg();
  outbox().length = 0;

  w.brreg.patchEntity(ORGNR.a, { konkurs: true });
  w.brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  assert.equal(outbox().length, 1, 'e-post skal gå selv om webhook feiler');
});
