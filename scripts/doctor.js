#!/usr/bin/env node
/**
 * Verifiserer at Registervakt faktisk kan snakke med omverdenen, og at
 * antakelsene om Brregs API stemmer mot det ekte API-et.
 *
 *   npm run doctor                  sjekker alt
 *   npm run doctor -- --send-test   sender i tillegg en ekte test-e-post
 *
 * Kjor denne FOR lansering. Den finnes fordi produktet ble bygget i et miljo
 * uten utgaende nett til Brreg, Stripe og Resend: feltnavn og responsformer er
 * utledet fra dokumentasjonen, ikke fra en levende respons. Denne sjekken
 * bekrefter eller avkrefter hver antakelse pa ett kall.
 */
import { config } from '../src/config.js';
import { normalizeEntity } from '../src/diff.js';
import { extractEmbeddedList, extractPageInfo } from '../src/brreg.js';

const ESC = '\u001b';
const GRONN = `${ESC}[32m`;
const ROD = `${ESC}[31m`;
const GUL = `${ESC}[33m`;
const GRA = `${ESC}[90m`;
const SLUTT = `${ESC}[0m`;

let feil = 0;
let advarsler = 0;

const ok = (msg, detalj) =>
  console.log(`${GRONN}  ok${SLUTT}   ${msg}${detalj ? `${GRA} - ${detalj}${SLUTT}` : ''}`);
const nei = (msg, detalj) => {
  feil += 1;
  console.log(`${ROD} FEIL${SLUTT}  ${msg}${detalj ? `\n        ${detalj}` : ''}`);
};
const obs = (msg, detalj) => {
  advarsler += 1;
  console.log(`${GUL} obs${SLUTT}   ${msg}${detalj ? `${GRA} - ${detalj}${SLUTT}` : ''}`);
};
const bolk = (navn) => console.log(`\n${navn}\n${'-'.repeat(navn.length)}`);
const graa = (tekst) => console.log(`${GRA}        ${tekst}${SLUTT}`);

async function hent(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'User-Agent': config.brreg.userAgent,
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* ikke JSON */ }
    return { response, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

async function sjekkBrregOppdateringer() {
  const siden = new Date(Date.now() - 36 * 3600_000).toISOString().replace(/\.\d+Z$/, '.000Z');
  const url = `${config.brreg.baseUrl}/oppdateringer/enheter?dato=${encodeURIComponent(siden)}&size=5`;

  let svar;
  try {
    svar = await hent(url);
  } catch (err) {
    nei('Fikk ikke kontakt med Brregs oppdateringsendepunkt', `${url}\n        ${err.message}`);
    return null;
  }

  if (!svar.response.ok) {
    nei(`Brreg svarte ${svar.response.status} pa /oppdateringer/enheter`,
      `${url}\n        ${svar.text.slice(0, 300)}`);
    return null;
  }
  ok('Brreg /oppdateringer/enheter svarer', `HTTP ${svar.response.status}`);

  const nokler = svar.body && svar.body._embedded ? Object.keys(svar.body._embedded) : [];
  if (!nokler.length) {
    nei('Fant ingen _embedded i svaret - responsformen er ikke som antatt',
      `Toppnivanokler: ${Object.keys(svar.body || {}).join(', ') || '(ingen)'}`);
    return null;
  }
  if (nokler.includes('oppdaterteEnheter')) {
    ok('_embedded.oppdaterteEnheter finnes som antatt');
  } else {
    obs(`_embedded bruker et annet nokkelnavn: ${nokler.join(', ')}`,
      'adapteren faller tilbake til forste array, sa dette virker likevel');
  }

  const liste = extractEmbeddedList(svar.body, ['oppdaterteEnheter']);
  const side = extractPageInfo(svar.body);
  ok('Paginering lest', `side ${side.number} av ${side.totalPages}, ${side.totalElements ?? '?'} elementer`);

  if (!liste.length) {
    obs('Ingen oppdateringer i perioden - kan ikke sjekke feltnavn i oppdateringsrader',
      'prov igjen pa en hverdag');
    return null;
  }

  const rad = liste[0];
  graa(`eksempelrad: ${JSON.stringify(rad)}`);
  for (const felt of ['oppdateringsid', 'organisasjonsnummer', 'endringstype']) {
    if (rad[felt] === undefined) {
      nei(`Oppdateringsrad mangler feltet "${felt}"`, 'src/brreg.js normalizeUpdateItem ma justeres');
    } else {
      ok(`Oppdateringsrad har "${felt}"`, String(rad[felt]));
    }
  }

  // Markorbasert paging er hele grunnlaget for at vi ikke mister endringer.
  const markor = rad.oppdateringsid;
  if (markor) {
    const url2 = `${config.brreg.baseUrl}/oppdateringer/enheter?oppdateringsid=${markor}&size=5`;
    const svar2 = await hent(url2);
    if (svar2.response.ok) {
      const liste2 = extractEmbeddedList(svar2.body, ['oppdaterteEnheter']);
      const ider = liste2.map((r) => r.oppdateringsid);
      ok('Markorbasert henting virker',
        `oppdateringsid=${markor} ga ${liste2.length} rader (forste: ${ider[0]})`);
      if (ider.length && ider[0] < markor) {
        nei('Markoren returnerer eldre rader enn forespurt',
          'pollesloyfen kan ga i ring - se RUNBOOK.md');
      }
    } else {
      nei(`Markorbasert henting feilet med ${svar2.response.status}`, url2);
    }
  }

  return liste[0].organisasjonsnummer;
}

async function sjekkBrregEnhet(orgnr) {
  // Faller tilbake pa Bronnoysundregistrene selv, som er et stabilt nummer.
  const nummer = orgnr || '974760673';
  const svar = await hent(`${config.brreg.baseUrl}/enheter/${nummer}`);

  if (svar.response.status === 410) {
    obs(`Enhet ${nummer} er slettet (HTTP 410)`, 'handteres, men velg et annet nummer for full sjekk');
    return;
  }
  if (!svar.response.ok) {
    nei(`Brreg svarte ${svar.response.status} for enhet ${nummer}`);
    return;
  }
  ok(`Brreg /enheter/${nummer} svarer`, svar.body.navn || '');

  for (const felt of ['organisasjonsnummer', 'navn', 'organisasjonsform']) {
    if (svar.body[felt] === undefined) {
      nei(`Enhet mangler pakrevd felt "${felt}"`, 'src/diff.js normalizeEntity ma justeres');
    } else {
      ok(`Enhet har "${felt}"`);
    }
  }

  const overvaket = [
    'konkurs', 'underAvvikling', 'underTvangsavviklingEllerTvangsopplosning',
    'registrertIMvaregisteret', 'naeringskode1', 'forretningsadresse', 'antallAnsatte',
  ];
  const manglende = overvaket.filter((felt) => svar.body[felt] === undefined);
  if (manglende.length) {
    obs(`Overvakede felter som mangler pa denne enheten: ${manglende.join(', ')}`,
      'kan vaere normalt for enkelte organisasjonsformer - sjekk mot et vanlig AS');
  } else {
    ok('Alle overvakede felter finnes pa enheten');
  }

  const normalisert = normalizeEntity(svar.body);
  graa(`normalisert: ${JSON.stringify(normalisert)}`);
  if (!normalisert.navn) nei('Navnet ble ikke plukket opp av normalizeEntity');
  if (normalisert.forretningsadresse === null && svar.body.forretningsadresse) {
    nei('Adressen ble ikke plukket opp av normalizeEntity', 'joinAddress i src/diff.js ma justeres');
  }

  const ukjent = await hent(`${config.brreg.baseUrl}/enheter/999999999`);
  if (ukjent.response.status === 404) ok('Ukjent organisasjonsnummer gir 404 som forventet');
  else obs(`Ukjent organisasjonsnummer ga ${ukjent.response.status}, ikke 404`);
}

async function sjekkStripe() {
  if (!config.stripe.secretKey) {
    nei('STRIPE_SECRET_KEY er ikke satt', 'ingen betaling er mulig');
    return;
  }
  if (config.stripe.secretKey.startsWith('sk_test_')) {
    obs('Stripe kjorer med TESTNOKKEL', 'ingen ekte penger kommer inn for du bytter til sk_live_');
  } else {
    ok('Stripe bruker live-nokkel');
  }

  const auth = { Authorization: `Bearer ${config.stripe.secretKey}` };
  const konto = await hent('https://api.stripe.com/v1/account', { headers: auth });
  if (!konto.response.ok) {
    nei(`Stripe avviste nokkelen (HTTP ${konto.response.status})`, konto.text.slice(0, 200));
    return;
  }
  ok('Stripe-nokkelen virker', konto.body.id);

  for (const [plan, priceId] of Object.entries(config.stripe.prices)) {
    if (!priceId) {
      nei(`Mangler pris-ID for planen "${plan}"`, `sett STRIPE_PRICE_${plan.toUpperCase()}`);
      continue;
    }
    const pris = await hent(`https://api.stripe.com/v1/prices/${priceId}`, { headers: auth });
    if (!pris.response.ok) {
      nei(`Fant ikke Stripe-prisen for "${plan}" (${priceId})`, pris.text.slice(0, 200));
      continue;
    }
    if (!pris.body.recurring) {
      nei(`Prisen for "${plan}" er ikke et abonnement`, 'ma vaere recurring med interval month');
    } else {
      const belop = pris.body.unit_amount ? pris.body.unit_amount / 100 : '?';
      ok(`Pris "${plan}" funnet`,
        `${belop} ${String(pris.body.currency).toUpperCase()} per ${pris.body.recurring.interval}`);
    }
  }

  if (!config.stripe.webhookSecret) {
    nei('STRIPE_WEBHOOK_SECRET er ikke satt', 'ingen kunder blir aktivert etter betaling');
  } else if (!config.stripe.webhookSecret.startsWith('whsec_')) {
    nei('STRIPE_WEBHOOK_SECRET ser ikke ut som en webhook-hemmelighet');
  } else {
    ok('Webhook-hemmelighet er satt');
    obs(`Bekreft i Stripe at endepunktet peker pa ${config.baseUrl}/stripe/webhook`,
      'og at checkout.session.completed, customer.subscription.* og invoice.payment_* er valgt');
  }
}

async function sjekkEpost() {
  if (config.mail.provider !== 'resend') {
    obs(`MAIL_PROVIDER er "${config.mail.provider}"`, 'ingen ekte e-post sendes');
    return;
  }
  if (!config.mail.resendApiKey) {
    nei('RESEND_API_KEY er ikke satt', 'ingen varsler kan sendes');
    return;
  }
  const domener = await hent('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${config.mail.resendApiKey}` },
  });
  if (!domener.response.ok) {
    nei(`Resend avviste nokkelen (HTTP ${domener.response.status})`, domener.text.slice(0, 200));
    return;
  }
  ok('Resend-nokkelen virker');

  const liste = (domener.body && (domener.body.data || domener.body)) || [];
  const avsender = (config.mail.from.match(/<([^>]+)>/) || [null, config.mail.from])[1];
  const domene = String(avsender).split('@')[1];
  const treff = Array.isArray(liste) ? liste.find((d) => d.name === domene) : null;

  if (!treff) {
    nei(`Avsenderdomenet "${domene}" er ikke lagt inn i Resend`,
      'e-post blir avvist - legg til domenet og fullfor DNS-oppsettet');
  } else if (treff.status !== 'verified') {
    nei(`Domenet "${domene}" har status "${treff.status}" i Resend`, 'DNS-oppsettet er ikke fullfort');
  } else {
    ok(`Avsenderdomenet "${domene}" er verifisert`);
  }

  if (process.argv.includes('--send-test')) {
    if (!config.ops.alertEmail) {
      nei('Kan ikke sende testmelding: ALERT_EMAIL er ikke satt');
      return;
    }
    const { sendMail } = await import('../src/mailer.js');
    try {
      await sendMail({
        to: config.ops.alertEmail,
        subject: `[${config.brand.name}] Testmelding fra doctor`,
        text: 'Hvis du leser dette, virker e-postutsendingen.',
        html: '<p>Hvis du leser dette, virker e-postutsendingen.</p>',
        kind: 'doctor',
      });
      ok(`Testmelding sendt til ${config.ops.alertEmail}`);
    } catch (err) {
      nei('Klarte ikke sende testmelding', err.message);
    }
  } else {
    graa('(kjor med --send-test for a sende en ekte testmelding)');
  }
}

async function sjekkOppsett() {
  if (config.baseUrl.startsWith('https://')) ok('BASE_URL er https', config.baseUrl);
  else if (config.isProduction) nei('BASE_URL ma vaere https i produksjon', config.baseUrl);
  else obs('BASE_URL er ikke https', config.baseUrl);

  if (!config.ops.alertEmail) nei('ALERT_EMAIL er ikke satt', 'du far ingen driftsvarsler');
  else ok('ALERT_EMAIL er satt', config.ops.alertEmail);

  if (!config.ops.adminToken) nei('ADMIN_TOKEN er ikke satt', '/admin-endepunktene er utilgjengelige');
  else if (config.ops.adminToken.length < 24) nei('ADMIN_TOKEN er for kort', 'bruk minst 24 tegn');
  else ok('ADMIN_TOKEN er satt og lang nok');

  try {
    const { getDb } = await import('../src/db.js');
    getDb().prepare('SELECT COUNT(*) AS n FROM accounts').get();
    ok('Databasen er lesbar og skrivbar', config.databasePath);
  } catch (err) {
    nei('Databasen kunne ikke apnes', err.message);
  }
}

console.log(`\n${config.brand.name} - sjekk av oppsett og eksterne avhengigheter`);
console.log(`Miljo: ${config.nodeEnv}   Base-URL: ${config.baseUrl}`);

bolk('Konfigurasjon og lagring');
await sjekkOppsett();

bolk('Bronnoysundregistrene');
const orgnr = await sjekkBrregOppdateringer();
await sjekkBrregEnhet(orgnr);

bolk('Stripe');
await sjekkStripe();

bolk('E-post');
await sjekkEpost();

console.log(`\n${'='.repeat(62)}`);
if (feil === 0 && advarsler === 0) {
  console.log(`${GRONN}Alt er i orden. Klar for lansering.${SLUTT}\n`);
} else if (feil === 0) {
  console.log(`${GUL}${advarsler} ting a se pa, men ingenting som blokkerer.${SLUTT}\n`);
} else {
  console.log(`${ROD}${feil} feil${SLUTT} og ${advarsler} advarsler. Rett feilene for lansering.\n`);
}
process.exit(feil > 0 ? 1 : 0);
