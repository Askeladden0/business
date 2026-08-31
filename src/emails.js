import { config } from './config.js';
import { escapeHtml } from './alerts.js';
import { describeEvent } from './diff.js';
import { formatOrgnr } from './orgnr.js';

const BRAND = config.brand.name;

function shell(title, bodyHtml, footerNote) {
  return `<!doctype html>
<html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c2024">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:10px;padding:28px">
<div style="font-weight:700;font-size:15px;letter-spacing:.02em;color:#0b5d3b;margin-bottom:20px">${escapeHtml(BRAND)}</div>
${bodyHtml}
</div>
<div style="max-width:560px;margin:16px auto 0;color:#6b7280;font-size:12px;line-height:1.5">
${footerNote ? `${escapeHtml(footerNote)}<br>` : ''}
Data fra Enhetsregisteret (Brønnøysundregistrene), oppdatert hvert døgn.<br>
<a href="${config.baseUrl}/app/innstillinger" style="color:#6b7280">Endre varslingsinnstillinger</a>
</div>
</body></html>`;
}

const button = (href, label) =>
  `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:#0b5d3b;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:7px;font-weight:600">${escapeHtml(label)}</a></p>`;

export function magicLinkEmail({ url }) {
  return {
    subject: `Logg inn på ${BRAND}`,
    html: shell(
      `Logg inn på ${BRAND}`,
      `<h1 style="margin:0 0 12px;font-size:19px">Logg inn</h1>
<p style="margin:0 0 8px">Trykk på knappen for å logge inn. Lenken virker i ${config.magicLinkMinutes} minutter og kan bare brukes én gang.</p>
${button(url, 'Logg inn')}
<p style="margin:0;color:#6b7280;font-size:13px">Virker ikke knappen? Kopier denne lenken:<br><span style="word-break:break-all">${escapeHtml(url)}</span></p>`,
      'Har du ikke bedt om denne e-posten, kan du se bort fra den.',
    ),
    text: `Logg inn på ${BRAND}:\n\n${url}\n\nLenken virker i ${config.magicLinkMinutes} minutter.\nHar du ikke bedt om den, kan du se bort fra denne e-posten.\n`,
  };
}

export function welcomeEmail({ url, planNavn }) {
  return {
    subject: `Velkommen til ${BRAND}`,
    html: shell(
      `Velkommen til ${BRAND}`,
      `<h1 style="margin:0 0 12px;font-size:19px">Velkommen</h1>
<p style="margin:0 0 8px">Abonnementet ditt på <strong>${escapeHtml(planNavn)}</strong> er aktivt. Neste steg er å legge inn organisasjonsnumrene du vil følge.</p>
${button(url, 'Åpne kontoen din')}
<p style="margin:0 0 6px;font-weight:600;font-size:14px">Slik kommer du i gang</p>
<ol style="margin:0;padding-left:20px;color:#4b5563;font-size:14px">
<li>Lim inn organisasjonsnumre, ett per linje, eller last opp en CSV.</li>
<li>Velg hvor mye du vil varsles om under Innstillinger.</li>
<li>Legg eventuelt inn en Slack-webhook.</li>
</ol>
<p style="margin:16px 0 0;color:#6b7280;font-size:13px">Vi varsler først når noe faktisk endrer seg i registeret. De første dagene er det normalt stille.</p>`,
      'Du kan si opp når som helst under Innstillinger.',
    ),
    text: `Velkommen til ${BRAND}.\n\nAbonnementet ditt på ${planNavn} er aktivt.\n\nÅpne kontoen din: ${url}\n\nSlik kommer du i gang:\n1. Lim inn organisasjonsnumre, ett per linje, eller last opp en CSV.\n2. Velg varslingsnivå under Innstillinger.\n3. Legg eventuelt inn en Slack-webhook.\n\nVi varsler først når noe faktisk endrer seg i registeret.\n`,
  };
}

const SEVERITY_STYLE = {
  kritisk: 'background:#fee2e2;color:#991b1b',
  viktig: 'background:#fef3c7;color:#92400e',
  info: 'background:#e5e7eb;color:#374151',
};

function eventRows(events) {
  const byOrgnr = new Map();
  for (const event of events) {
    const key = event.orgnr;
    if (!byOrgnr.has(key)) byOrgnr.set(key, { navn: event.navn, orgnr: key, events: [] });
    byOrgnr.get(key).events.push(event);
  }
  return [...byOrgnr.values()];
}

export function alertEmail({ events, digest = false }) {
  const groups = eventRows(events);
  const kritiske = events.filter((e) => e.severity === 'kritisk').length;

  const heading = digest
    ? `Daglig oppsummering: ${events.length} ${events.length === 1 ? 'endring' : 'endringer'}`
    : `${events.length} ${events.length === 1 ? 'endring' : 'endringer'} i selskaper du følger`;

  const subject = kritiske
    ? `${BRAND}: ${kritiske} kritisk${kritiske === 1 ? '' : 'e'} ${
        kritiske === 1 ? 'endring' : 'endringer'
      }`
    : `${BRAND}: ${heading}`;

  const groupsHtml = groups
    .map(
      (group) => `<div style="border:1px solid #e3e5e8;border-radius:8px;padding:14px 16px;margin:0 0 12px">
<div style="font-weight:600;font-size:15px">${escapeHtml(group.navn || 'Ukjent navn')}</div>
<div style="color:#6b7280;font-size:13px;margin-bottom:8px">
  <a href="https://virksomhet.brreg.no/nb/oppslag/enheter/${escapeHtml(group.orgnr)}" style="color:#6b7280">${escapeHtml(formatOrgnr(group.orgnr))}</a>
</div>
<ul style="margin:0;padding-left:18px">
${group.events
  .map(
    (event) => `<li style="margin:0 0 5px">
<span style="display:inline-block;${SEVERITY_STYLE[event.severity] || SEVERITY_STYLE.info};font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;margin-right:6px;text-transform:uppercase;letter-spacing:.03em">${escapeHtml(event.severity)}</span>
${escapeHtml(describeEvent(event))}</li>`,
  )
  .join('\n')}
</ul></div>`,
    )
    .join('\n');

  const textBody = groups
    .map(
      (group) =>
        `${group.navn || 'Ukjent navn'} (${formatOrgnr(group.orgnr)})\n` +
        group.events.map((event) => `  [${event.severity}] ${describeEvent(event)}`).join('\n'),
    )
    .join('\n\n');

  return {
    subject,
    html: shell(
      subject,
      `<h1 style="margin:0 0 16px;font-size:19px">${escapeHtml(heading)}</h1>
${groupsHtml}
${button(`${config.baseUrl}/app/hendelser`, 'Se alle hendelser')}`,
      digest ? 'Du får denne oppsummeringen én gang i døgnet.' : null,
    ),
    text: `${heading}\n\n${textBody}\n\nSe alle hendelser: ${config.baseUrl}/app/hendelser\n`,
  };
}

export function paymentFailedEmail({ url }) {
  return {
    subject: `${BRAND}: betalingen gikk ikke gjennom`,
    html: shell(
      'Betalingen gikk ikke gjennom',
      `<h1 style="margin:0 0 12px;font-size:19px">Betalingen gikk ikke gjennom</h1>
<p style="margin:0 0 8px">Vi fikk ikke belastet kortet ditt. Overvåkingen fortsetter foreløpig, men kontoen settes ned til gratisplanen hvis betalingen ikke går gjennom.</p>
${button(url, 'Oppdater betalingskort')}`,
      'Har kortet nettopp blitt fornyet, holder det å legge inn det nye.',
    ),
    text: `Betalingen gikk ikke gjennom.\n\nOppdater betalingskortet her: ${url}\n\nOvervåkingen fortsetter foreløpig, men kontoen settes ned til gratisplanen hvis betalingen ikke går gjennom.\n`,
  };
}

export function subscriptionEndedEmail() {
  return {
    subject: `${BRAND}: abonnementet er avsluttet`,
    html: shell(
      'Abonnementet er avsluttet',
      `<h1 style="margin:0 0 12px;font-size:19px">Abonnementet er avsluttet</h1>
<p style="margin:0 0 8px">Kontoen din er satt ned til gratisplanen. Vaktlisten din er beholdt, men vi følger nå bare de tre første selskapene og sender daglig oppsummering.</p>
${button(`${config.baseUrl}/app/innstillinger`, 'Start abonnementet igjen')}`,
      null,
    ),
    text: `Abonnementet er avsluttet. Kontoen er satt ned til gratisplanen.\n\nVaktlisten din er beholdt, men vi følger nå bare de tre første selskapene.\n\nStart igjen: ${config.baseUrl}/app/innstillinger\n`,
  };
}
