import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { config } from './config.js';
import { log } from './log.js';
import { getDb, lastSuccessfulRun, lastRun } from './db.js';
import { createRouter } from './router.js';
import {
  readBody, parseForm, parseJson, cookies, html, json, text, redirect, send,
  sameOrigin, clientIp, rateLimit, HttpError,
} from './http.js';
import {
  ensureAccount, findAccountByEmail, findAccountByApiKey, isValidEmail, normalizeEmail,
  updateAccount, rotateApiKey,
} from './accounts.js';
import {
  createMagicLink, consumeMagicLink, createSession, accountFromSession, destroySession,
  sessionCookie, clearSessionCookie, SESSION_COOKIE, safeEqual,
} from './auth.js';
import { sendMail } from './mailer.js';
import { magicLinkEmail } from './emails.js';
import { effectivePlan, PLANS } from './plans.js';
import { listWatches, addWatch, removeWatch, countWatches } from './watches.js';
import { needsFetch, refreshEntity } from './entities.js';
import { mapWithConcurrency } from './brreg.js';
import { parseOrgnrList, formatOrgnr, isValidOrgnr, normalizeOrgnr } from './orgnr.js';
import { describeEvent } from './diff.js';
import {
  createCheckoutSession, createPortalSession, constructEvent, handleStripeEvent, stripeConfigured,
} from './stripe.js';
import { parseDbTime, runJob, pollBrreg, sendDailyDigest, healthWatchdog, cleanup, backupDatabase } from './jobs.js';
import {
  landingPage, loginPage, simplePage, dashboardPage, eventsPage, settingsPage, layout,
} from './views.js';

const here = dirname(fileURLToPath(import.meta.url));
const STYLESHEET = readFileSync(join(here, '..', 'public', 'style.css'), 'utf8');
const STYLE_ETAG = `"${createHash('sha256').update(STYLESHEET).digest('hex').slice(0, 16)}"`;

const router = createRouter();

// --- hjelpere -------------------------------------------------------------

function currentAccount(req) {
  return accountFromSession(cookies(req)[SESSION_COOKIE]);
}

function requireAccount(req, res) {
  const account = currentAccount(req);
  if (!account) {
    redirect(res, '/logg-inn');
    return null;
  }
  return account;
}

function requireSameOrigin(req) {
  if (!sameOrigin(req)) throw new HttpError(403, 'Forespørselen kom fra feil opphav');
}

function flash(url, key, message) {
  return `${url}?${key}=${encodeURIComponent(message)}`;
}

async function loginByEmail(email, { mustExist = false } = {}) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return { ok: false, feil: 'Ugyldig e-postadresse' };
  const account = mustExist ? findAccountByEmail(normalized) : ensureAccount(normalized);
  // Ved innlogging røper vi ikke om adressen finnes hos oss.
  if (!account) return { ok: true, ukjent: true };
  const link = createMagicLink(account.email);
  await sendMail({ to: account.email, ...magicLinkEmail({ url: link.url }), kind: 'innlogging' });
  return { ok: true, account };
}

// --- offentlige sider -----------------------------------------------------

router.get('/style.css', (req, res) => {
  if (req.headers['if-none-match'] === STYLE_ETAG) {
    send(res, 304, '', { ETag: STYLE_ETAG });
    return;
  }
  send(res, 200, STYLESHEET, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    ETag: STYLE_ETAG,
  });
});

router.get('/', (req, res, { url }) => {
  html(res, 200, landingPage({
    account: currentAccount(req),
    melding: url.searchParams.get('melding'),
    feil: url.searchParams.get('feil'),
  }));
});

router.get('/personvern', (req, res) => {
  html(res, 200, simplePage({
    title: 'Personvern',
    account: currentAccount(req),
    body: `
<p class="muted">Sist oppdatert 31. august 2026.</p>
<h3>Hva vi lagrer om deg</h3>
<p>E-postadressen din, hvilken plan du har, Stripe-kundenummeret ditt, organisasjonsnumrene du følger,
og innstillingene dine. Betalingskortet ditt ser vi aldri — det håndteres i sin helhet av Stripe.</p>
<h3>Hva vi lagrer om selskapene</h3>
<p>Offentlige opplysninger fra Enhetsregisteret: navn, organisasjonsform, adresse, næringskode,
antall ansatte, MVA-registrering og status. Vi lagrer <strong>ikke</strong> navn på styremedlemmer,
daglig leder eller andre roller.</p>
<h3>Hvorfor</h3>
<p>For å levere tjenesten du har bestilt, og for å kunne fakturere den. Vi selger ikke data videre,
og vi bruker den ikke til noe annet.</p>
<h3>Hvor lenge</h3>
<p>Så lenge du har konto. Sletter du kontoen under Innstillinger, slettes konto, vaktliste og
hendelseshistorikk umiddelbart. Regnskapsbilag hos Stripe beholdes så lenge bokføringsloven krever.</p>
<h3>Databehandlere</h3>
<p>Stripe (betaling), Resend (e-postutsending) og Fly.io (drift). Ingen andre.</p>
<h3>Rettighetene dine</h3>
<p>Innsyn, retting, sletting og dataportabilitet. Send en e-post til
<a href="mailto:${config.brand.supportEmail}">${config.brand.supportEmail}</a>, så ordner vi det.</p>`,
  }));
});

router.get('/vilkar', (req, res) => {
  html(res, 200, simplePage({
    title: 'Vilkår',
    account: currentAccount(req),
    body: `
<p class="muted">Sist oppdatert 31. august 2026.</p>
<h3>Tjenesten</h3>
<p>${config.brand.name} overvåker Enhetsregisteret og varsler deg om endringer på de
organisasjonsnumrene du legger inn. Kilden er Brønnøysundregistrenes åpne data, som oppdateres én
gang i døgnet. Vi kan ikke være ferskere enn kilden.</p>
<h3>Hva vi ikke er</h3>
<p>Vi er ikke et kredittopplysningsforetak. Vi gir ingen kredittvurdering, ingen score og ingen
anbefaling om hvem du bør handle med. Varslene er faktaopplysninger fra et offentlig register.
Beslutninger du tar på grunnlag av dem, er dine egne.</p>
<h3>Ansvar</h3>
<p>Vi gjør vårt beste for å varsle raskt og riktig, men vi kan ikke garantere at hvert varsel kommer
frem, eller at registeret alltid er korrekt. Ansvaret vårt er i alle tilfeller begrenset til det du
har betalt de siste tre månedene. Tjenesten leveres som den er.</p>
<h3>Betaling</h3>
<p>Abonnementet løper månedlig og fornyes automatisk til du sier det opp. Du sier opp selv i
betalingsportalen, med virkning fra neste periode. Vi refunderer ikke påbegynte perioder, men du
beholder tilgangen ut perioden du har betalt for.</p>
<h3>Oppsigelse fra vår side</h3>
<p>Vi kan stenge en konto som misbruker tjenesten, med varsel per e-post og refusjon av ubrukt tid.</p>
<h3>Lovvalg</h3>
<p>Norsk rett. Verneting er saksøktes alminnelige verneting.</p>`,
  }));
});

router.get('/status', (req, res) => {
  const poll = lastSuccessfulRun('poll');
  const ageMinutes = poll ? Math.round((Date.now() - parseDbTime(poll.started_at)) / 60_000) : null;
  const friskt = ageMinutes !== null && ageMinutes < config.ops.stalePollHours * 60;
  html(res, 200, simplePage({
    title: 'Status',
    account: currentAccount(req),
    body: `
<p>
  <span class="badge ${friskt ? 'ok' : 'viktig'}">${friskt ? 'I drift' : 'Venter på første kjøring'}</span>
</p>
<table style="margin-top:18px">
  <tr><th>Siste vellykkede sjekk mot Brreg</th><td>${poll ? `${e(poll.started_at)} (${ageMinutes} min siden)` : 'ingen ennå'}</td></tr>
  <tr><th>Sjekkintervall</th><td>hver ${config.brreg.pollIntervalMinutes}. minutt</td></tr>
  <tr><th>Datakilde</th><td>Enhetsregisteret, oppdatert nattlig av Brønnøysundregistrene</td></tr>
</table>
<p class="small muted" style="margin-top:20px">Denne siden viser om overvåkingen kjører. Den sier ingenting
om hvor mange endringer som er funnet.</p>`,
  }));
});

function e(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Helsesjekk for ekstern overvåking. 503 betyr «varsle eieren».
router.get('/healthz', (req, res) => {
  const checks = {};
  let ok = true;
  try {
    getDb().prepare('SELECT 1').get();
    checks.database = 'ok';
  } catch (err) {
    checks.database = `feil: ${err.message}`;
    ok = false;
  }

  const poll = lastSuccessfulRun('poll');
  const maxAgeMs = config.ops.stalePollHours * 3600_000;
  if (!poll) {
    // Etter en fersk deploy er dette forventet, ikke en feil.
    const grace = process.uptime() * 1000 < maxAgeMs;
    checks.poll = grace ? 'ikke kjørt ennå (innenfor oppstartsvindu)' : 'har aldri lyktes';
    if (!grace) ok = false;
  } else {
    const age = Date.now() - parseDbTime(poll.started_at);
    checks.poll = `sist ok for ${Math.round(age / 60_000)} min siden`;
    if (age > maxAgeMs) ok = false;
  }

  json(res, ok ? 200 : 503, {
    status: ok ? 'ok' : 'nede',
    versjon: process.env.APP_VERSION || 'dev',
    oppetidSekunder: Math.round(process.uptime()),
    sjekker: checks,
  });
});

// --- registrering og innlogging ------------------------------------------

router.post('/registrer', async (req, res, { body }) => {
  requireSameOrigin(req);
  const limit = rateLimit(`registrer:${clientIp(req)}`, { max: 5, windowMs: 600_000 });
  if (!limit.ok) {
    redirect(res, flash('/', 'feil', 'For mange forsøk. Prøv igjen om litt.'));
    return;
  }
  const form = parseForm(body);
  const result = await loginByEmail(form.email);
  if (!result.ok) {
    redirect(res, flash('/', 'feil', result.feil));
    return;
  }
  redirect(res, flash('/logg-inn', 'sendt', '1'));
});

router.get('/logg-inn', (req, res, { url }) => {
  html(res, 200, loginPage({
    sendt: url.searchParams.get('sendt') === '1',
    melding: url.searchParams.get('melding'),
    feil: url.searchParams.get('feil'),
  }));
});

router.post('/logg-inn', async (req, res, { body }) => {
  requireSameOrigin(req);
  const limit = rateLimit(`logginn:${clientIp(req)}`, { max: 8, windowMs: 600_000 });
  if (!limit.ok) {
    html(res, 429, loginPage({ feil: 'For mange forsøk. Prøv igjen om ti minutter.' }));
    return;
  }
  const form = parseForm(body);
  const result = await loginByEmail(form.email, { mustExist: true });
  if (!result.ok) {
    html(res, 400, loginPage({ feil: result.feil }));
    return;
  }
  redirect(res, '/logg-inn?sendt=1');
});

router.get('/auth/verifiser', (req, res, { url }) => {
  const email = consumeMagicLink(url.searchParams.get('token'));
  if (!email) {
    html(res, 400, loginPage({ feil: 'Lenken er brukt opp eller utløpt. Be om en ny.' }));
    return;
  }
  const account = ensureAccount(email);
  const session = createSession(account.id);
  redirect(res, '/app', 303, { 'Set-Cookie': sessionCookie(session.token) });
});

router.get('/logg-ut', (req, res) => {
  destroySession(cookies(req)[SESSION_COOKIE]);
  redirect(res, '/', 303, { 'Set-Cookie': clearSessionCookie() });
});

router.get('/velkommen', (req, res) => {
  html(res, 200, simplePage({
    title: 'Takk for bestillingen',
    account: currentAccount(req),
    body: `<p>Betalingen er registrert. Vi har sendt deg en innloggingslenke på e-post — trykk på den, så
er du i gang.</p>
<p class="small muted">Kommer den ikke innen et par minutter, sjekk søppelposten. Du kan også
<a href="/logg-inn">be om en ny lenke</a>.</p>`,
  }));
});

// --- betaling -------------------------------------------------------------

router.post('/kjop', async (req, res, { body }) => {
  requireSameOrigin(req);
  const form = parseForm(body);
  const planId = form.plan;
  if (!PLANS[planId] || PLANS[planId].prisNok === 0) {
    redirect(res, flash('/', 'feil', 'Ukjent plan'));
    return;
  }
  if (!isValidEmail(form.email)) {
    redirect(res, flash('/', 'feil', 'Ugyldig e-postadresse'));
    return;
  }
  if (!stripeConfigured()) {
    redirect(res, flash('/', 'feil', 'Betaling er ikke satt opp ennå. Ta kontakt.'));
    return;
  }
  try {
    const session = await createCheckoutSession({ email: form.email, planId });
    redirect(res, session.url);
  } catch (err) {
    log.error('kunne ikke opprette checkout', { err });
    redirect(res, flash('/', 'feil', 'Vi fikk ikke startet betalingen. Prøv igjen.'));
  }
});

router.post('/app/portal', async (req, res) => {
  const account = requireAccount(req, res);
  if (!account) return;
  requireSameOrigin(req);
  if (!account.stripe_customer_id) {
    redirect(res, flash('/app/innstillinger', 'feil', 'Du har ikke et aktivt abonnement.'));
    return;
  }
  try {
    const portal = await createPortalSession(account.stripe_customer_id);
    redirect(res, portal.url);
  } catch (err) {
    log.error('kunne ikke åpne betalingsportalen', { err });
    redirect(res, flash('/app/innstillinger', 'feil', 'Fikk ikke åpnet betalingsportalen.'));
  }
});

router.post('/stripe/webhook', async (req, res, { body }) => {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = constructEvent(body, signature);
  } catch (err) {
    log.warn('avviste stripe-webhook', { err: err.message });
    json(res, 400, { error: 'ugyldig signatur' });
    return;
  }
  try {
    const result = await handleStripeEvent(event);
    json(res, 200, { mottatt: true, ...result });
  } catch (err) {
    // 500 får Stripe til å prøve igjen, som er det vi vil ved forbigående feil.
    log.error('feil under behandling av stripe-hendelse', { err, type: event.type });
    json(res, 500, { error: 'kunne ikke behandle hendelsen' });
  }
});

// --- innlogget grensesnitt ------------------------------------------------

router.get('/app', (req, res, { url }) => {
  const account = requireAccount(req, res);
  if (!account) return;
  html(res, 200, dashboardPage({
    account,
    plan: effectivePlan(account),
    watches: listWatches(account.id),
    melding: url.searchParams.get('melding'),
    feil: url.searchParams.get('feil'),
    importResultat: null,
  }));
});

// Hvor mange organisasjonsnumre vi tar imot i én innliming. Grensen finnes for
// at forespørselen ikke skal henge mens vi slår opp hundrevis av enheter.
const MAKS_PER_IMPORT = 300;

router.post('/app/vakter', async (req, res, { body }) => {
  const account = requireAccount(req, res);
  if (!account) return;
  requireSameOrigin(req);
  const form = parseForm(body);
  const { valid, invalid } = parseOrgnrList(form.orgnr || '');

  if (!valid.length && !invalid.length) {
    redirect(res, flash('/app', 'feil', 'Fant ingen organisasjonsnumre i det du limte inn.'));
    return;
  }

  const kandidater = valid.slice(0, MAKS_PER_IMPORT);
  const lagtTil = [];
  const avvist = invalid.map((orgnr) => ({
    orgnr,
    melding: 'Ikke et gyldig organisasjonsnummer',
  }));
  for (const orgnr of valid.slice(MAKS_PER_IMPORT)) {
    avvist.push({ orgnr, melding: `Over grensen på ${MAKS_PER_IMPORT} per innliming — lim inn resten etterpå` });
  }

  // Slå opp de ukjente enhetene parallelt før vi legger dem inn én for én.
  // Sekvensiell henting av 300 numre ville tatt minutter.
  const ukjente = kandidater.filter((orgnr) => needsFetch(orgnr));
  if (ukjente.length) {
    await mapWithConcurrency(ukjente, config.brreg.concurrency, (orgnr) =>
      refreshEntity(orgnr, { emitEvents: false }));
  }

  for (const orgnr of kandidater) {
    const result = await addWatch(account, orgnr);
    if (result.ok) lagtTil.push(result);
    else avvist.push({ orgnr, melding: result.melding });
  }

  html(res, 200, dashboardPage({
    account,
    plan: effectivePlan(account),
    watches: listWatches(account.id),
    melding: null,
    feil: null,
    importResultat: { lagtTil, avvist },
  }));
});

router.post('/app/vakter/slett', (req, res, { body }) => {
  const account = requireAccount(req, res);
  if (!account) return;
  requireSameOrigin(req);
  const form = parseForm(body);
  const fjernet = removeWatch(account.id, form.orgnr);
  redirect(res, flash('/app', 'melding', fjernet ? 'Selskapet er fjernet.' : 'Fant ikke selskapet.'));
});

router.get('/app/hendelser', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) return;
  const events = getDb()
    .prepare(
      `SELECT e.* FROM events e
       JOIN watches w ON w.orgnr = e.orgnr AND w.account_id = ?
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT 300`,
    )
    .all(account.id);
  html(res, 200, eventsPage({ account, events }));
});

router.get('/app/innstillinger', (req, res, { url }) => {
  const account = requireAccount(req, res);
  if (!account) return;
  html(res, 200, settingsPage({
    account,
    plan: effectivePlan(account),
    melding: url.searchParams.get('melding'),
    feil: url.searchParams.get('feil'),
    harStripe: stripeConfigured(),
  }));
});

router.post('/app/innstillinger', (req, res, { body }) => {
  const account = requireAccount(req, res);
  if (!account) return;
  requireSameOrigin(req);
  const form = parseForm(body);
  const plan = effectivePlan(account);

  const alertLevel = ['kritisk', 'viktig', 'alle'].includes(form.alert_level)
    ? form.alert_level
    : account.alert_level;
  const deliveryMode = plan.tvungenDaglig
    ? 'daglig'
    : form.delivery_mode === 'daglig'
      ? 'daglig'
      : 'straks';

  let webhookUrl = account.webhook_url;
  let webhookKind = account.webhook_kind;
  let webhookSecret = account.webhook_secret;
  if (plan.webhook) {
    const raw = String(form.webhook_url || '').trim();
    if (!raw) {
      webhookUrl = null;
    } else if (/^https:\/\//i.test(raw)) {
      webhookUrl = raw.slice(0, 500);
    } else {
      redirect(res, flash('/app/innstillinger', 'feil', 'Webhook-URL må begynne med https://'));
      return;
    }
    webhookKind = form.webhook_kind === 'json' ? 'json' : 'slack';
    webhookSecret = String(form.webhook_secret || '').trim().slice(0, 200) || null;
  }

  updateAccount(account.id, {
    alert_level: alertLevel,
    delivery_mode: deliveryMode,
    extra_recipients: String(form.extra_recipients || '').slice(0, 500),
    webhook_url: webhookUrl,
    webhook_kind: webhookKind,
    webhook_secret: webhookSecret,
  });
  redirect(res, flash('/app/innstillinger', 'melding', 'Innstillingene er lagret.'));
});

router.post('/app/api-nokkel', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) return;
  requireSameOrigin(req);
  if (!effectivePlan(account).api) {
    redirect(res, flash('/app/innstillinger', 'feil', 'API er med i Byrå-planen.'));
    return;
  }
  rotateApiKey(account.id);
  redirect(res, flash('/app/innstillinger', 'melding', 'Ny API-nøkkel er laget.'));
});

router.post('/app/slett-konto', (req, res, { body }) => {
  const account = requireAccount(req, res);
  if (!account) return;
  requireSameOrigin(req);
  const form = parseForm(body);
  if (String(form.bekreft || '').trim().toUpperCase() !== 'SLETT') {
    redirect(res, flash('/app/innstillinger', 'feil', 'Skriv SLETT for å bekrefte.'));
    return;
  }
  // Fremmednøkler med ON DELETE CASCADE rydder vakter, sesjoner og leveringer.
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
  log.info('konto slettet av bruker', { accountId: account.id });
  redirect(res, flash('/', 'melding', 'Kontoen din er slettet.'), 303, {
    'Set-Cookie': clearSessionCookie(),
  });
});

// --- API ------------------------------------------------------------------

function apiAccount(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const account = findAccountByApiKey(match[1].trim());
  if (!account) return null;
  if (!effectivePlan(account).api) return null;
  return account;
}

function requireApi(req, res) {
  const account = apiAccount(req);
  if (!account) {
    json(res, 401, { feil: 'Ugyldig eller manglende API-nøkkel' });
    return null;
  }
  const limit = rateLimit(`api:${account.id}`, { max: 120, windowMs: 60_000 });
  if (!limit.ok) {
    json(res, 429, { feil: 'For mange kall' }, { 'Retry-After': String(limit.retryAfterSeconds) });
    return null;
  }
  return account;
}

router.get('/api/v1/vakter', (req, res) => {
  const account = requireApi(req, res);
  if (!account) return;
  json(res, 200, {
    antall: countWatches(account.id),
    grense: effectivePlan(account).maxWatches,
    vakter: listWatches(account.id).map((w) => ({
      orgnr: w.orgnr,
      navn: w.entity_navn,
      status: w.snapshot
        ? {
            konkurs: Boolean(w.snapshot.konkurs),
            underAvvikling: Boolean(w.snapshot.underAvvikling),
            underTvangsavvikling: Boolean(w.snapshot.underTvangsavvikling),
            slettet: Boolean(w.snapshot.slettet),
          }
        : null,
      sistSjekket: w.last_checked,
    })),
  });
});

router.post('/api/v1/vakter', async (req, res, { body }) => {
  const account = requireApi(req, res);
  if (!account) return;
  const payload = parseJson(body);
  const input = Array.isArray(payload.orgnr) ? payload.orgnr : [payload.orgnr];
  const resultater = [];
  for (const value of input.filter(Boolean)) {
    const result = await addWatch(account, value, { label: payload.merkelapp || null });
    resultater.push({
      orgnr: normalizeOrgnr(value),
      lagtTil: result.ok,
      ...(result.ok ? { navn: result.navn } : { grunn: result.reason, melding: result.melding }),
    });
  }
  const noenLagtTil = resultater.some((r) => r.lagtTil);
  json(res, noenLagtTil ? 201 : 400, { resultater });
});

router.delete('/api/v1/vakter/:orgnr', (req, res, { params }) => {
  const account = requireApi(req, res);
  if (!account) return;
  const fjernet = removeWatch(account.id, params.orgnr);
  json(res, fjernet ? 200 : 404, { fjernet });
});

router.get('/api/v1/hendelser', (req, res, { url }) => {
  const account = requireApi(req, res);
  if (!account) return;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const rows = getDb()
    .prepare(
      `SELECT e.* FROM events e
       JOIN watches w ON w.orgnr = e.orgnr AND w.account_id = ?
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`,
    )
    .all(account.id, limit);
  json(res, 200, {
    antall: rows.length,
    hendelser: rows.map((row) => ({
      orgnr: row.orgnr,
      navn: row.navn,
      type: row.type,
      alvorlighet: row.severity,
      felt: row.felt,
      fra: row.fra_verdi,
      til: row.til_verdi,
      tidspunkt: row.occurred_at,
      beskrivelse: describeEvent(row),
    })),
  });
});

// --- drift ----------------------------------------------------------------

function requireAdmin(req, res, url) {
  const token = url.searchParams.get('token') || req.headers['x-admin-token'];
  if (!config.ops.adminToken || !safeEqual(token, config.ops.adminToken)) {
    json(res, 404, { feil: 'ikke funnet' });
    return false;
  }
  return true;
}

router.get('/admin/status', (req, res, { url }) => {
  if (!requireAdmin(req, res, url)) return;
  const db = getDb();
  json(res, 200, {
    kontoer: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
    betalende: db
      .prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan != 'gratis' AND status = 'active'")
      .get().n,
    vakter: db.prepare('SELECT COUNT(*) AS n FROM watches').get().n,
    unikeEnheter: db.prepare('SELECT COUNT(*) AS n FROM entities').get().n,
    hendelserSiste7Dager: db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE occurred_at > datetime('now','-7 days')").get().n,
    ventendeLeveringer: db
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'").get().n,
    fastlaasteLeveringer: db
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending' AND attempts >= 5").get().n,
    jobber: ['poll', 'digest', 'watchdog', 'cleanup', 'backup'].map((job) => ({
      job,
      siste: lastRun(job),
      sisteOk: lastSuccessfulRun(job),
    })),
  });
});

const MANUAL_JOBS = {
  poll: pollBrreg,
  digest: sendDailyDigest,
  watchdog: healthWatchdog,
  cleanup,
  backup: backupDatabase,
};

router.post('/admin/kjor', async (req, res, { url }) => {
  if (!requireAdmin(req, res, url)) return;
  const name = url.searchParams.get('jobb');
  const fn = MANUAL_JOBS[name];
  if (!fn) {
    json(res, 400, { feil: `Ukjent jobb. Gyldige: ${Object.keys(MANUAL_JOBS).join(', ')}` });
    return;
  }
  const result = await runJob(name, fn);
  json(res, result.ok ? 200 : 500, {
    jobb: name,
    ok: result.ok,
    detalj: result.detail,
    feil: result.error ? result.error.message : null,
  });
});

router.get('/admin/eksport', (req, res, { url }) => {
  if (!requireAdmin(req, res, url)) return;
  const rows = getDb()
    .prepare(
      `SELECT a.email, a.plan, a.status, a.created_at, w.orgnr
       FROM accounts a LEFT JOIN watches w ON w.account_id = a.id ORDER BY a.id`,
    )
    .all();
  const csv = ['epost,plan,status,opprettet,orgnr']
    .concat(rows.map((r) => [r.email, r.plan, r.status, r.created_at, r.orgnr || ''].join(',')))
    .join('\n');
  text(res, 200, csv, { 'Content-Disposition': 'attachment; filename="registervakt-eksport.csv"' });
});

// --- serveren -------------------------------------------------------------

export async function handleRequest(req, res) {
  const url = new URL(req.url, config.baseUrl);
  const started = Date.now();

  try {
    const match = router.match(req.method, url.pathname);
    if (!match) {
      html(res, 404, layout({
        title: 'Fant ikke siden',
        body: '<section style="border-bottom:none"><h1>Fant ikke siden</h1><p><a href="/">Til forsiden</a></p></section>',
      }));
      return;
    }

    let body = Buffer.alloc(0);
    if (req.method === 'POST' || req.method === 'PUT') body = await readBody(req);

    await match.handler(req, res, { url, params: match.params, body });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) {
      log.error('ubehandlet feil i forespørsel', { err, path: url.pathname, method: req.method });
    } else {
      log.warn('avvist forespørsel', { status, path: url.pathname, melding: err.message });
    }
    if (!res.headersSent) {
      const wantsJson =
        url.pathname.startsWith('/api/') ||
        String(req.headers.accept || '').includes('application/json');
      if (wantsJson) json(res, status, { feil: status >= 500 ? 'Intern feil' : err.message });
      else {
        html(res, status, layout({
          title: status >= 500 ? 'Noe gikk galt' : 'Kan ikke gjøre det',
          body: `<section style="border-bottom:none"><h1>${status >= 500 ? 'Noe gikk galt' : 'Kan ikke gjøre det'}</h1>
<p>${status >= 500 ? 'Feilen er logget og eieren er varslet.' : e(err.message)}</p>
<p><a href="/">Til forsiden</a></p></section>`,
        }));
      }
    }
    if (status >= 500) {
      const { opsAlert } = await import('./alerts.js');
      await opsAlert(
        `http:${url.pathname}:${err.message}`,
        `Feil på ${url.pathname}`,
        `${err.message}\n\n${err.stack || ''}`,
      );
    }
  } finally {
    log.debug('forespørsel', {
      method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started,
    });
  }
}

export function createAppServer() {
  return createServer(handleRequest);
}

export { router };
