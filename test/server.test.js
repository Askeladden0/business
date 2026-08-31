import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWorld, startTestServer, loginAs, ORGNR } from './helpers/app.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { outbox } from '../src/mailer.js';
import { findAccountByEmail, updateAccount } from '../src/accounts.js';
import { addWatch } from '../src/watches.js';
import { pollBrreg } from '../src/jobs.js';

async function app(t) {
  const w = await setupWorld();
  const server = await startTestServer();
  t.after(async () => {
    await server.close();
    await w.teardown();
  });
  return { ...w, ...server };
}

test('forsiden viser verdiløfte og priser', async (t) => {
  const { client } = await app(t);
  const response = await client.get('/');
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /Vet det når kunden din går konkurs/);
  assert.match(body, /249 kr/);
  assert.match(body, /749 kr/);
  assert.match(body, /Enhetsregisteret/);
  assert.match(body, /ikke et kredittopplysningsforetak/i);
});

test('innlogget område krever innlogging', async (t) => {
  const { client } = await app(t);
  for (const path of ['/app', '/app/hendelser', '/app/innstillinger']) {
    const response = await client.get(path);
    assert.equal(response.status, 303, path);
    assert.match(response.headers.get('location'), /logg-inn/);
  }
});

test('gratis registrering sender innloggingslenke', async (t) => {
  const { client } = await app(t);
  const response = await client.post('/registrer', { email: 'gratis@test.no' });
  assert.equal(response.status, 303);
  assert.ok(findAccountByEmail('gratis@test.no'), 'kontoen skal være opprettet');
  assert.equal(outbox().length, 1);
  assert.match(outbox()[0].text, /\/auth\/verifiser\?token=/);
});

test('engangslenken logger inn og kan bare brukes én gang', async (t) => {
  const { client } = await app(t);
  await client.post('/registrer', { email: 'engangs@test.no' });
  const token = outbox()[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];

  const first = await client.get(`/auth/verifiser?token=${token}`);
  assert.equal(first.status, 303);
  assert.match(first.headers.get('location'), /\/app/);

  const dashboard = await client.get('/app');
  assert.equal(dashboard.status, 200);

  const second = await client.request(`/auth/verifiser?token=${token}`, { headers: { Cookie: '' } });
  assert.equal(second.status, 400);
});

test('innlogging røper ikke om adressen finnes', async (t) => {
  const { client } = await app(t);
  const response = await client.post('/logg-inn', { email: 'finnes-ikke@test.no' });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /sendt=1/);
  assert.equal(outbox().length, 0, 'ingen e-post til ukjent adresse');
  assert.equal(findAccountByEmail('finnes-ikke@test.no'), undefined, 'ingen konto opprettes');
});

test('kunden kan legge til, se og fjerne selskaper', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'bruker@test.no');
  updateAccount(account.id, { plan: 'solo' });
  brreg.setEntity(ORGNR.a, { navn: 'FØRSTE AS' });
  brreg.setEntity(ORGNR.b, { navn: 'ANDRE AS' });

  const added = await client.post('/app/vakter', { orgnr: `${ORGNR.a}\n${ORGNR.b}` });
  const body = await added.text();
  assert.equal(added.status, 200);
  assert.match(body, /2 lagt til/);
  assert.match(body, /FØRSTE AS/);
  assert.match(body, /ANDRE AS/);

  const removed = await client.post('/app/vakter/slett', { orgnr: ORGNR.a });
  assert.equal(removed.status, 303);
  const after = await (await client.get('/app')).text();
  assert.ok(!after.includes('FØRSTE AS'));
  assert.match(after, /ANDRE AS/);
});

test('CSV-lim inn plukker ut numrene og rapporterer avvisninger', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'csv@test.no');
  updateAccount(account.id, { plan: 'solo' });
  brreg.setEntity(ORGNR.a);

  const csv = ['orgnr;navn', `${ORGNR.a};Gyldig AS`, '123456789;Feil kontrollsiffer', '999999999;Finnes ikke'].join('\n');
  const response = await client.post('/app/vakter', { orgnr: csv });
  const body = await response.text();

  assert.match(body, /1 lagt til/);
  assert.match(body, /Ikke et gyldig organisasjonsnummer/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM watches').get().n, 1);
});

test('ukjent organisasjonsnummer avvises ved innlegging', async (t) => {
  const { client } = await app(t);
  const account = await loginAs(client, 'ukjent@test.no');
  updateAccount(account.id, { plan: 'solo' });

  const response = await client.post('/app/vakter', { orgnr: ORGNR.a });
  const body = await response.text();
  assert.match(body, /Fant ikke dette organisasjonsnummeret/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM watches').get().n, 0);
});

test('hendelsessiden viser endringer for kundens selskaper', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'hendelser@test.no');
  updateAccount(account.id, { plan: 'solo' });
  brreg.setEntity(ORGNR.a, { navn: 'HENDELSE AS' });
  await addWatch(findAccountByEmail('hendelser@test.no'), ORGNR.a);
  await pollBrreg();
  brreg.patchEntity(ORGNR.a, { konkurs: true });
  brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  const body = await (await client.get('/app/hendelser')).text();
  assert.match(body, /HENDELSE AS/);
  assert.match(body, /Konkurs er registrert/);
  assert.match(body, /kritisk/);
});

test('kunden ser ikke andre kunders hendelser', async (t) => {
  const { client, brreg } = await app(t);
  brreg.setEntity(ORGNR.a, { navn: 'HEMMELIG AS' });
  const annen = await loginAs(client, 'annen@test.no');
  updateAccount(annen.id, { plan: 'solo' });
  await addWatch(findAccountByEmail('annen@test.no'), ORGNR.a);
  await pollBrreg();
  brreg.patchEntity(ORGNR.a, { konkurs: true });
  brreg.pushUpdate(ORGNR.a);
  await pollBrreg();

  client.cookie = '';
  await loginAs(client, 'nysgjerrig@test.no');
  const body = await (await client.get('/app/hendelser')).text();
  assert.ok(!body.includes('HEMMELIG AS'), 'skal ikke se andres selskaper');
});

test('innstillinger lagres og valideres', async (t) => {
  const { client } = await app(t);
  const account = await loginAs(client, 'innst@test.no');
  updateAccount(account.id, { plan: 'solo' });

  await client.post('/app/innstillinger', {
    alert_level: 'alle',
    delivery_mode: 'daglig',
    extra_recipients: 'kollega@test.no',
    webhook_url: 'https://hooks.slack.com/services/abc',
    webhook_kind: 'slack',
  });
  const saved = findAccountByEmail('innst@test.no');
  assert.equal(saved.alert_level, 'alle');
  assert.equal(saved.delivery_mode, 'daglig');
  assert.equal(saved.webhook_url, 'https://hooks.slack.com/services/abc');

  const bad = await client.post('/app/innstillinger', { webhook_url: 'http://usikker.no/hook' });
  assert.match(bad.headers.get('location'), /https/);
  assert.equal(findAccountByEmail('innst@test.no').webhook_url, 'https://hooks.slack.com/services/abc');
});

test('gratisplanen kan ikke tvinge frem umiddelbar varsling', async (t) => {
  const { client } = await app(t);
  await loginAs(client, 'gratisplan@test.no');
  await client.post('/app/innstillinger', { alert_level: 'alle', delivery_mode: 'straks' });
  assert.equal(findAccountByEmail('gratisplan@test.no').delivery_mode, 'daglig');
});

test('API krever gyldig nøkkel og riktig plan', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'api@test.no');
  updateAccount(account.id, { plan: 'solo' });
  const soloKey = findAccountByEmail('api@test.no').api_key;

  const uten = await client.request('/api/v1/vakter');
  assert.equal(uten.status, 401);

  const feilPlan = await client.request('/api/v1/vakter', {
    headers: { Authorization: `Bearer ${soloKey}` },
  });
  assert.equal(feilPlan.status, 401, 'Solo har ikke API-tilgang');

  updateAccount(account.id, { plan: 'byraa' });
  const key = findAccountByEmail('api@test.no').api_key;
  brreg.setEntity(ORGNR.a, { navn: 'API AS' });

  const lagt = await client.request('/api/v1/vakter', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgnr: [ORGNR.a, '123456789'] }),
  });
  assert.equal(lagt.status, 201);
  const lagtBody = await lagt.json();
  assert.equal(lagtBody.resultater[0].lagtTil, true);
  assert.equal(lagtBody.resultater[1].lagtTil, false);

  const liste = await (await client.request('/api/v1/vakter', {
    headers: { Authorization: `Bearer ${key}` },
  })).json();
  assert.equal(liste.antall, 1);
  assert.equal(liste.vakter[0].navn, 'API AS');

  const slettet = await client.request(`/api/v1/vakter/${ORGNR.a}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(slettet.status, 200);
});

test('forespørsler fra fremmed opphav avvises', async (t) => {
  const { client } = await app(t);
  await loginAs(client, 'csrf@test.no');
  const response = await client.request('/app/vakter/slett', {
    method: 'POST',
    headers: { Origin: 'https://ondsinnet.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'orgnr=812345672',
  });
  assert.equal(response.status, 403);
});

test('admin-endepunkter er skjult uten riktig token', async (t) => {
  const { client } = await app(t);
  assert.equal((await client.get('/admin/status')).status, 404);
  assert.equal((await client.get('/admin/status?token=feil')).status, 404);
  const ok = await client.get(`/admin/status?token=${config.ops.adminToken}`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(typeof body.kontoer, 'number');
  assert.ok(Array.isArray(body.jobber));
});

test('kontoen kan slettes av kunden selv, med bekreftelse', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'slettmeg@test.no');
  updateAccount(account.id, { plan: 'solo' });
  brreg.setEntity(ORGNR.a);
  await addWatch(findAccountByEmail('slettmeg@test.no'), ORGNR.a);

  const uten = await client.post('/app/slett-konto', { bekreft: 'nei' });
  assert.match(uten.headers.get('location'), /feil=/);
  assert.ok(findAccountByEmail('slettmeg@test.no'), 'kontoen skal fortsatt finnes');

  const med = await client.post('/app/slett-konto', { bekreft: 'SLETT' });
  assert.equal(med.status, 303);
  assert.equal(findAccountByEmail('slettmeg@test.no'), undefined);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS n FROM watches').get().n, 0,
    'vaktene skal slettes med kontoen',
  );
});

test('helsesjekken svarer 503 når pollejobben er for gammel', async (t) => {
  const { client } = await app(t);
  const frisk = await client.get('/healthz');
  assert.equal(frisk.status, 200);

  getDb()
    .prepare(
      `INSERT INTO job_runs (job, status, started_at, finished_at, duration_ms)
       VALUES ('poll', 'ok', ?, ?, 1)`,
    )
    .run(new Date(Date.now() - 48 * 3600_000).toISOString(), new Date().toISOString());

  const syk = await client.get('/healthz');
  assert.equal(syk.status, 503);
  const body = await syk.json();
  assert.equal(body.status, 'nede');
});

test('for mange innloggingsforsøk blir bremset', async (t) => {
  const { client } = await app(t);
  let siste;
  for (let i = 0; i < 12; i += 1) {
    siste = await client.post('/logg-inn', { email: `spam${i}@test.no` });
  }
  assert.equal(siste.status, 429);
});

test('svarene har grunnleggende sikkerhetshoder', async (t) => {
  const { client } = await app(t);
  const response = await client.get('/');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
});

test('ukjent sti gir 404 og feil metode gir 405', async (t) => {
  const { client } = await app(t);
  assert.equal((await client.get('/finnes-ikke')).status, 404);
  assert.equal((await client.post('/healthz', {})).status, 405);
});

test('stor CSV-import henter enheter parallelt og bruker få runder', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'bulk@test.no');
  updateAccount(account.id, { plan: 'byraa' });

  // Lag 60 gyldige organisasjonsnumre med korrekt mod-11-kontrollsiffer.
  const vekter = [3, 2, 7, 6, 5, 4, 3, 2];
  const numre = [];
  for (let i = 0; numre.length < 60 && i < 400; i += 1) {
    const prefiks = String(81000000 + i);
    let sum = 0;
    for (let j = 0; j < 8; j += 1) sum += Number(prefiks[j]) * vekter[j];
    const rest = sum % 11;
    const kontroll = rest === 0 ? 0 : 11 - rest;
    if (kontroll === 10) continue;
    const orgnr = `${prefiks}${kontroll}`;
    numre.push(orgnr);
    brreg.setEntity(orgnr, { navn: `BULK ${orgnr}` });
  }
  assert.equal(numre.length, 60);

  const start = Date.now();
  const response = await client.post('/app/vakter', { orgnr: numre.join('\n') });
  const body = await response.text();

  assert.match(body, /60 lagt til/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM watches').get().n, 60);
  assert.ok(Date.now() - start < 15_000, 'import skal ikke ta urimelig lang tid');
});

test('innliming over grensen avvises tydelig i stedet for å henge', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'formange@test.no');
  updateAccount(account.id, { plan: 'byraa' });

  const vekter = [3, 2, 7, 6, 5, 4, 3, 2];
  const numre = [];
  for (let i = 0; numre.length < 310 && i < 2000; i += 1) {
    const prefiks = String(81000000 + i);
    let sum = 0;
    for (let j = 0; j < 8; j += 1) sum += Number(prefiks[j]) * vekter[j];
    const rest = sum % 11;
    const kontroll = rest === 0 ? 0 : 11 - rest;
    if (kontroll === 10) continue;
    const orgnr = `${prefiks}${kontroll}`;
    numre.push(orgnr);
    brreg.setEntity(orgnr, { navn: `MANGE ${orgnr}` });
  }

  const body = await (await client.post('/app/vakter', { orgnr: numre.join('\n') })).text();
  assert.match(body, /Over grensen/);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS n FROM watches').get().n, 300,
    'nøyaktig grensen skal legges inn',
  );
});

test('ukjent organisasjonsnummer slås ikke opp på nytt med en gang', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'gjentatt@test.no');
  updateAccount(account.id, { plan: 'solo' });

  await client.post('/app/vakter', { orgnr: ORGNR.a });
  const etterForste = brreg.state.requests.length;

  // Nytt forsøk på samme ukjente nummer skal bruke det vi allerede vet.
  const body = await (await client.post('/app/vakter', { orgnr: ORGNR.a })).text();
  assert.match(body, /Fant ikke dette organisasjonsnummeret/);
  assert.equal(brreg.state.requests.length, etterForste, 'ingen nytt oppslag mot Brreg');
});

test('nummeret kan legges inn når det senere dukker opp i registeret', async (t) => {
  const { client, brreg } = await app(t);
  const account = await loginAs(client, 'senere@test.no');
  updateAccount(account.id, { plan: 'solo' });

  await client.post('/app/vakter', { orgnr: ORGNR.a });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM watches').get().n, 0);

  // Selskapet blir registrert, og markeringen om "finnes ikke" er ikke evig.
  brreg.setEntity(ORGNR.a, { navn: 'NYREGISTRERT AS' });
  getDb()
    .prepare("UPDATE entities SET last_checked = datetime('now', '-2 hours') WHERE orgnr = ?")
    .run(ORGNR.a);

  const body = await (await client.post('/app/vakter', { orgnr: ORGNR.a })).text();
  assert.match(body, /1 lagt til/);
  assert.match(body, /NYREGISTRERT AS/);
});
