import { config } from './config.js';
import { escapeHtml as e } from './alerts.js';
import { PLANS } from './plans.js';
import { EVENT_TYPES, describeEvent } from './diff.js';
import { formatOrgnr } from './orgnr.js';

const BRAND = config.brand.name;

export function layout({ title, body, account = null, description = '', wide = false }) {
  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} — ${e(BRAND)}</title>
${description ? `<meta name="description" content="${e(description)}">` : ''}
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='14'>%F0%9F%94%94</text></svg>">
</head>
<body>
<header class="site"><div class="wrap">
  <a class="brand" href="/">Register<span>vakt</span></a>
  <nav>
    <a href="/#slik">Slik virker det</a>
    <a href="/#priser">Priser</a>
    ${
      account
        ? '<a href="/app">Min konto</a><a href="/logg-ut">Logg ut</a>'
        : '<a href="/logg-inn">Logg inn</a>'
    }
  </nav>
</div></header>
<main class="wrap${wide ? '' : ''}">${body}</main>
<footer class="site"><div class="wrap">
  <nav>
    <a href="/">Forsiden</a>
    <a href="/personvern">Personvern</a>
    <a href="/vilkar">Vilkår</a>
    <a href="/status">Status</a>
  </nav>
  <p class="tiny">Data hentes fra Enhetsregisteret hos Brønnøysundregistrene og oppdateres én gang i døgnet.
  ${e(BRAND)} er ikke et kredittopplysningsforetak og gir verken kredittvurdering eller råd.</p>
</div></footer>
</body></html>`;
}

function planCard(plan, { featured = false } = {}) {
  const kjop =
    plan.prisNok === 0
      ? `<form method="post" action="/registrer">
           <label for="e-${plan.id}">E-post</label>
           <input id="e-${plan.id}" type="email" name="email" required placeholder="deg@firma.no">
           <button class="btn secondary" type="submit" style="margin-top:12px;width:100%">Start gratis</button>
         </form>`
      : `<form method="post" action="/kjop">
           <input type="hidden" name="plan" value="${e(plan.id)}">
           <label for="e-${plan.id}">E-post</label>
           <input id="e-${plan.id}" type="email" name="email" required placeholder="deg@firma.no">
           <button class="btn" type="submit" style="margin-top:12px;width:100%">Prøv i ${config.stripe.trialDays} dager</button>
         </form>`;

  return `<div class="card plan${featured ? ' featured' : ''}">
    <h3>${e(plan.navn)}</h3>
    <div class="price">${plan.prisNok === 0 ? '0 kr' : `${plan.prisNok} kr`} <small>/ mnd</small></div>
    <p class="small muted" style="margin-top:6px">${e(plan.beskrivelse)}</p>
    <ul>${plan.punkter.map((p) => `<li>${e(p)}</li>`).join('')}</ul>
    ${kjop}
  </div>`;
}

const EVENT_LIST = Object.entries(EVENT_TYPES)
  .sort((a, b) => {
    const rank = { kritisk: 0, viktig: 1, info: 2 };
    return rank[a[1].severity] - rank[b[1].severity];
  })
  .map(
    ([key, meta]) =>
      `<tr><td><span class="badge ${meta.severity}">${meta.severity}</span></td><td>${e(meta.tekst)}</td><td class="tiny muted"><code>${e(key)}</code></td></tr>`,
  )
  .join('');

export function landingPage({ account, melding = null, feil = null }) {
  return layout({
    title: 'Varsel når selskaper endrer seg i Enhetsregisteret',
    description:
      'Legg inn organisasjonsnumrene du følger. Registervakt sier fra på e-post eller Slack når et selskap går konkurs, avvikles, bytter navn, adresse eller slettes.',
    account,
    body: `
<section class="hero">
  ${melding ? `<div class="notice ok">${e(melding)}</div>` : ''}
  ${feil ? `<div class="notice feil">${e(feil)}</div>` : ''}
  <h1>Vet det når kunden din går konkurs</h1>
  <p class="lead">Legg inn organisasjonsnumrene du bryr deg om. Vi holder øye med Enhetsregisteret
  hver dag og sier fra på e-post eller Slack når noe faktisk endrer seg — konkurs, tvangsavvikling,
  sletting, navnebytte, flytting eller endring i MVA-registeret.</p>
  <div class="cta">
    <a class="btn" href="#priser">Se priser</a>
    <a class="btn secondary" href="#slik">Slik virker det</a>
  </div>
  <p class="small muted" style="margin-top:20px">Ingen salgssamtale. Ingen bindingstid. ${config.stripe.trialDays} dagers prøvetid på betalte planer.</p>
</section>

<section id="slik">
  <h2>Slik virker det</h2>
  <div class="grid c3" style="margin-top:20px">
    <div class="card"><h3>1. Legg inn selskapene</h3>
      <p class="small muted">Lim inn organisasjonsnumre, ett per linje, eller last opp kundelisten som CSV.
      Vi henter navn og status fra registeret med en gang.</p></div>
    <div class="card"><h3>2. Vi følger med</h3>
      <p class="small muted">Hver time leser vi endringsstrømmen fra Brønnøysundregistrene og sammenlikner
      med det vi så sist. Ingen endring betyr ingen e-post.</p></div>
    <div class="card"><h3>3. Du får beskjed</h3>
      <p class="small muted">Med én gang, eller som én daglig oppsummering. Til e-post, Slack eller din
      egen webhook. Du velger selv hvor mye som er verdt et varsel.</p></div>
  </div>
</section>

<section>
  <h2>Hva vi varsler om</h2>
  <p class="muted small">Alt hentet fra Enhetsregisteret. Du kan skru av de minst viktige.</p>
  <div class="table-scroll" style="margin-top:16px">
    <table><thead><tr><th>Nivå</th><th>Hendelse</th><th>Kode</th></tr></thead>
    <tbody>${EVENT_LIST}</tbody></table>
  </div>
</section>

<section id="priser">
  <h2>Priser</h2>
  <p class="muted small">Alle priser er eksklusive merverdiavgift. Si opp selv, når som helst.</p>
  <div class="grid c3" style="margin-top:20px">
    ${planCard(PLANS.gratis)}
    ${planCard(PLANS.solo, { featured: true })}
    ${planCard(PLANS.byraa)}
  </div>
</section>

<section>
  <h2>Hva dette ikke er</h2>
  <div class="grid c2" style="margin-top:16px">
    <div class="card">
      <h3>Ikke kredittvurdering</h3>
      <p class="small muted">Vi regner ingen score og gir ingen anbefaling om hvem du bør handle med.
      Vi videreformidler faktiske registerhendelser. Trenger du kredittvurdering, skal du bruke et
      kredittopplysningsforetak.</p>
    </div>
    <div class="card">
      <h3>Ikke sanntid</h3>
      <p class="small muted">Brønnøysundregistrene oppdaterer sine åpne data én gang i døgnet, om natten.
      Vi kan ikke være raskere enn kilden, og lover det heller ikke.</p>
    </div>
    <div class="card">
      <h3>Ingen personopplysninger om roller</h3>
      <p class="small muted">Vi sporer bevisst ikke styremedlemmer eller daglig leder. Det er
      personopplysninger vi ikke trenger for å gjøre jobben.</p>
    </div>
    <div class="card">
      <h3>Ingen regnskapstall</h3>
      <p class="small muted">Vi varsler om registerendringer, ikke om årsregnskap, omsetning eller
      betalingsanmerkninger.</p>
    </div>
  </div>
</section>

<section style="border-bottom:none">
  <h2>Spørsmål</h2>
  <div style="margin-top:16px">
    <details><summary>Hvor kommer dataene fra?</summary>
      <p>Enhetsregisteret hos Brønnøysundregistrene, via deres åpne API. Dataene er offentlige og
      gratis tilgjengelige. Det du betaler for er overvåkingen: at noen krysser endringsstrømmen mot
      din liste hver dag og sier fra.</p></details>
    <details><summary>Hvor mange e-poster får jeg?</summary>
      <p>Én per runde der noe faktisk har endret seg, med alle endringene samlet — ikke én per hendelse.
      Velger du daglig oppsummering, får du høyst én i døgnet. Følger du 50 rolige selskaper, kan det gå
      uker mellom hver e-post.</p></details>
    <details><summary>Kan jeg få det inn i Slack?</summary>
      <p>Ja. Lim inn en Slack-webhook under Innstillinger på Solo eller Byrå. Du kan også få signert
      JSON til din egen endepunkt.</p></details>
    <details><summary>Hva skjer hvis jeg sier opp?</summary>
      <p>Kontoen faller ned på gratisplanen. Vaktlisten din blir liggende, men vi varsler bare om de tre
      første selskapene. Sier du opp fra betalingsportalen, skjer alt automatisk.</p></details>
    <details><summary>Følger dere underenheter?</summary>
      <p>Foreløpig følger vi hovedenheter. Legger du inn et organisasjonsnummer for en underenhet,
      sier vi fra at vi ikke fant det.</p></details>
  </div>
</section>`,
  });
}

export function loginPage({ melding = null, feil = null, sendt = false }) {
  return layout({
    title: 'Logg inn',
    body: `<section class="narrow" style="border-bottom:none">
  <h1>Logg inn</h1>
  ${melding ? `<div class="notice ok">${e(melding)}</div>` : ''}
  ${feil ? `<div class="notice feil">${e(feil)}</div>` : ''}
  ${
    sendt
      ? `<p>Vi har sendt deg en innloggingslenke. Den virker i ${config.magicLinkMinutes} minutter.</p>
         <p class="small muted">Får du den ikke, sjekk søppelpost — eller om du har en konto hos oss i det hele tatt.</p>`
      : `<p class="muted">Vi bruker engangslenker på e-post. Ingen passord å glemme.</p>
         <form method="post" action="/logg-inn">
           <label for="email">E-post</label>
           <input id="email" type="email" name="email" required autofocus placeholder="deg@firma.no">
           <button class="btn" type="submit" style="margin-top:16px">Send innloggingslenke</button>
         </form>
         <p class="small muted" style="margin-top:20px">Har du ikke konto? <a href="/#priser">Se priser</a>.</p>`
  }
</section>`,
  });
}

export function simplePage({ title, body, account = null }) {
  return layout({
    title,
    account,
    body: `<section class="narrow" style="border-bottom:none"><h1>${e(title)}</h1>${body}</section>`,
  });
}

function appNav(active) {
  const items = [
    ['/app', 'Selskaper'],
    ['/app/hendelser', 'Hendelser'],
    ['/app/innstillinger', 'Innstillinger'],
  ];
  return `<nav class="app-nav">${items
    .map(
      ([href, label]) =>
        `<a href="${href}"${href === active ? ' class="active"' : ''}>${e(label)}</a>`,
    )
    .join('')}</nav>`;
}

function statusBadge(watch) {
  const snapshot = watch.snapshot;
  if (watch.fetch_error && !snapshot) return `<span class="badge kritisk">Ukjent</span>`;
  if (!snapshot) return `<span class="badge info">Henter…</span>`;
  if (snapshot.slettet) return `<span class="badge kritisk">Slettet</span>`;
  if (snapshot.konkurs) return `<span class="badge kritisk">Konkurs</span>`;
  if (snapshot.underTvangsavvikling) return `<span class="badge kritisk">Tvangsavvikling</span>`;
  if (snapshot.underAvvikling) return `<span class="badge viktig">Under avvikling</span>`;
  return `<span class="badge ok">Aktiv</span>`;
}

export function dashboardPage({ account, plan, watches, melding, feil, importResultat }) {
  const rows = watches.length
    ? watches
        .map(
          (w, index) => `<tr>
  <td>
    <strong>${e(w.entity_navn || w.label || 'Ukjent navn')}</strong>
    ${index >= plan.maxWatches ? '<br><span class="badge viktig">Utenfor planen</span>' : ''}
    ${w.snapshot && w.snapshot.organisasjonsformTekst ? `<br><span class="tiny muted">${e(w.snapshot.organisasjonsformTekst)}</span>` : ''}
  </td>
  <td class="small"><a href="https://virksomhet.brreg.no/nb/oppslag/enheter/${e(w.orgnr)}" rel="noopener noreferrer" target="_blank">${e(formatOrgnr(w.orgnr))}</a></td>
  <td>${statusBadge(w)}</td>
  <td class="tiny muted">${w.last_checked ? e(w.last_checked) : 'ikke sjekket ennå'}</td>
  <td style="text-align:right">
    <form method="post" action="/app/vakter/slett" onsubmit="return confirm('Slutte å følge ${e(w.entity_navn || w.orgnr)}?')">
      <input type="hidden" name="orgnr" value="${e(w.orgnr)}">
      <button class="btn danger small" type="submit">Fjern</button>
    </form>
  </td>
</tr>`,
        )
        .join('')
    : `<tr><td colspan="5" class="muted small" style="padding:22px">Ingen selskaper ennå. Legg inn organisasjonsnumre under.</td></tr>`;

  const importHtml = importResultat
    ? `<div class="notice ${importResultat.lagtTil.length ? 'ok' : 'feil'}">
        <strong>${importResultat.lagtTil.length} lagt til.</strong>
        ${importResultat.avvist.length ? `<br>${importResultat.avvist.length} ble ikke lagt til:` : ''}
        ${
          importResultat.avvist.length
            ? `<ul class="small" style="margin:8px 0 0;padding-left:18px">${importResultat.avvist
                .slice(0, 15)
                .map((a) => `<li>${e(formatOrgnr(a.orgnr))} — ${e(a.melding)}</li>`)
                .join('')}${importResultat.avvist.length > 15 ? `<li>… og ${importResultat.avvist.length - 15} til</li>` : ''}</ul>`
            : ''
        }
      </div>`
    : '';

  return layout({
    title: 'Selskaper',
    account,
    body: `<section style="border-bottom:none">
${appNav('/app')}
${melding ? `<div class="notice ok">${e(melding)}</div>` : ''}
${feil ? `<div class="notice feil">${e(feil)}</div>` : ''}
${importHtml}

<div class="stat-row">
  <div class="stat"><div class="n">${watches.length} <span class="muted" style="font-size:16px">/ ${plan.maxWatches}</span></div><div class="l">Selskaper</div></div>
  <div class="stat"><div class="n">${e(plan.navn)}</div><div class="l">Plan${account.status === 'past_due' ? ' — betaling mangler' : ''}</div></div>
  <div class="stat"><div class="n">${account.delivery_mode === 'daglig' || plan.tvungenDaglig ? 'Daglig' : 'Straks'}</div><div class="l">Varsling</div></div>
</div>

${
  watches.length > plan.maxWatches
    ? `<div class="notice feil">Du følger ${watches.length} selskaper, men planen din dekker ${plan.maxWatches}.
       Vi varsler kun om de ${plan.maxWatches} første. <a href="/app/innstillinger">Oppgrader</a> eller fjern noen.</div>`
    : ''
}

<div class="table-scroll">
  <table>
    <thead><tr><th>Selskap</th><th>Orgnr</th><th>Status</th><th>Sist sjekket (UTC)</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<h2 style="margin-top:34px">Legg til selskaper</h2>
<form method="post" action="/app/vakter">
  <label for="orgnr">Organisasjonsnumre</label>
  <textarea id="orgnr" name="orgnr" placeholder="923609016&#10;974760673&#10;&#10;Du kan også lime inn en hel CSV — vi plukker ut organisasjonsnumrene."></textarea>
  <div class="field-hint">Ett per linje, eller lim inn en kolonne fra regnearket. Vi tåler mellomrom og andre kolonner.</div>
  <button class="btn" type="submit" style="margin-top:14px">Legg til</button>
</form>
</section>`,
  });
}

export function eventsPage({ account, events }) {
  const rows = events.length
    ? events
        .map(
          (event) => `<tr>
  <td class="tiny muted" style="white-space:nowrap">${e(event.occurred_at.slice(0, 16).replace('T', ' '))}</td>
  <td><span class="badge ${e(event.severity)}">${e(event.severity)}</span></td>
  <td><strong>${e(event.navn || 'Ukjent')}</strong><br><span class="tiny muted">${e(formatOrgnr(event.orgnr))}</span></td>
  <td class="small">${e(describeEvent(event))}</td>
</tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="muted small" style="padding:22px">Ingen hendelser ennå. Det er gode nyheter.</td></tr>`;

  return layout({
    title: 'Hendelser',
    account,
    body: `<section style="border-bottom:none">
${appNav('/app/hendelser')}
<h1>Hendelser</h1>
<p class="muted small">Alt vi har registrert på selskapene du følger, nyeste først. Vises uavhengig av varslingsnivå.</p>
<div class="table-scroll" style="margin-top:18px">
  <table><thead><tr><th>Tidspunkt</th><th>Nivå</th><th>Selskap</th><th>Hendelse</th></tr></thead>
  <tbody>${rows}</tbody></table>
</div>
</section>`,
  });
}

export function settingsPage({ account, plan, melding, feil, harStripe }) {
  const valgt = (value, current) => (value === current ? ' selected' : '');
  return layout({
    title: 'Innstillinger',
    account,
    body: `<section style="border-bottom:none">
${appNav('/app/innstillinger')}
<h1>Innstillinger</h1>
${melding ? `<div class="notice ok">${e(melding)}</div>` : ''}
${feil ? `<div class="notice feil">${e(feil)}</div>` : ''}

<div class="card" style="margin-bottom:26px">
  <h3>Abonnement</h3>
  <p class="small muted" style="margin-bottom:10px">
    Plan: <strong>${e(plan.navn)}</strong> — ${plan.prisNok === 0 ? 'gratis' : `${plan.prisNok} kr/mnd`}.
    Status: <strong>${e(account.status)}</strong>.
    ${account.current_period_end ? `Neste fornyelse ${e(account.current_period_end.slice(0, 10))}.` : ''}
  </p>
  ${
    account.stripe_customer_id && harStripe
      ? `<form method="post" action="/app/portal"><button class="btn secondary" type="submit">Åpne betalingsportalen</button></form>
         <p class="tiny muted" style="margin-top:8px">Der bytter du kort, laster ned kvitteringer eller sier opp.</p>`
      : harStripe
        ? `<form method="post" action="/kjop" class="inline">
             <input type="hidden" name="email" value="${e(account.email)}">
             <select name="plan" style="max-width:220px">
               <option value="solo">Solo — ${PLANS.solo.prisNok} kr/mnd</option>
               <option value="byraa">Byrå — ${PLANS.byraa.prisNok} kr/mnd</option>
             </select>
             <button class="btn" type="submit">Oppgrader</button>
           </form>`
        : '<p class="small muted">Betaling er ikke satt opp på denne installasjonen ennå.</p>'
  }
</div>

<form method="post" action="/app/innstillinger">
  <div class="card" style="margin-bottom:26px">
    <h3>Varsling</h3>
    <label for="alert_level">Hva vil du varsles om?</label>
    <select id="alert_level" name="alert_level">
      <option value="kritisk"${valgt('kritisk', account.alert_level)}>Bare kritisk — konkurs, tvangsavvikling, sletting</option>
      <option value="viktig"${valgt('viktig', account.alert_level)}>Kritisk og viktig — også navn, organisasjonsform, avvikling, MVA-sletting</option>
      <option value="alle"${valgt('alle', account.alert_level)}>Alt — også adresse, næringskode og antall ansatte</option>
    </select>

    <label for="delivery_mode">Når vil du ha varselet?</label>
    <select id="delivery_mode" name="delivery_mode"${plan.tvungenDaglig ? ' disabled' : ''}>
      <option value="straks"${valgt('straks', account.delivery_mode)}>Med én gang vi ser endringen</option>
      <option value="daglig"${valgt('daglig', account.delivery_mode)}>Én daglig oppsummering</option>
    </select>
    ${plan.tvungenDaglig ? '<div class="field-hint">Gratisplanen får daglig oppsummering. Oppgrader for varsel med én gang.</div>' : ''}

    <label for="extra_recipients">Flere mottakere</label>
    <input id="extra_recipients" type="text" name="extra_recipients" value="${e(account.extra_recipients || '')}" placeholder="kollega@firma.no, regnskap@firma.no">
    <div class="field-hint">Kommaseparert. Planen din tillater ${plan.maxExtraRecipients} i tillegg til deg.</div>
  </div>

  <div class="card" style="margin-bottom:26px">
    <h3>Webhook</h3>
    ${
      plan.webhook
        ? `<label for="webhook_url">URL</label>
           <input id="webhook_url" type="url" name="webhook_url" value="${e(account.webhook_url || '')}" placeholder="https://hooks.slack.com/services/…">
           <label for="webhook_kind">Format</label>
           <select id="webhook_kind" name="webhook_kind">
             <option value="slack"${valgt('slack', account.webhook_kind)}>Slack (enkel tekst)</option>
             <option value="json"${valgt('json', account.webhook_kind)}>JSON (signert med HMAC-SHA256)</option>
           </select>
           <label for="webhook_secret">Signeringsnøkkel</label>
           <input id="webhook_secret" type="text" name="webhook_secret" value="${e(account.webhook_secret || '')}" placeholder="valgfri — brukes i X-Registervakt-Signature">`
        : '<p class="small muted">Webhook er med i Solo og Byrå.</p>'
    }
  </div>

  <button class="btn" type="submit">Lagre</button>
</form>

${
  plan.api
    ? `<div class="card" style="margin-top:26px">
        <h3>API</h3>
        <p class="small muted">Send nøkkelen som <code>Authorization: Bearer …</code>.</p>
        <pre>GET  ${e(config.baseUrl)}/api/v1/vakter
POST ${e(config.baseUrl)}/api/v1/vakter     {"orgnr": "923609016"}
GET  ${e(config.baseUrl)}/api/v1/hendelser</pre>
        <label>Nøkkel</label>
        <input type="text" value="${e(account.api_key || '')}" readonly onclick="this.select()">
        <form method="post" action="/app/api-nokkel" style="margin-top:12px"
              onsubmit="return confirm('Lag ny nøkkel? Den gamle slutter å virke med en gang.')">
          <button class="btn secondary small" type="submit">Lag ny nøkkel</button>
        </form>
      </div>`
    : ''
}

<div class="card" style="margin-top:26px">
  <h3>Slett kontoen</h3>
  <p class="small muted">Sletter konto, vaktliste og hendelseshistorikk permanent. Har du et aktivt
  abonnement, må du si det opp i betalingsportalen først.</p>
  <form method="post" action="/app/slett-konto"
        onsubmit="return confirm('Slette kontoen og alle data permanent?')">
    <label for="bekreft">Skriv <code>SLETT</code> for å bekrefte</label>
    <input id="bekreft" type="text" name="bekreft" placeholder="SLETT" style="max-width:220px">
    <button class="btn danger small" type="submit" style="margin-top:12px">Slett kontoen</button>
  </form>
</div>
</section>`,
  });
}
