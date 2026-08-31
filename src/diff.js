import { createHash } from 'node:crypto';

export const SEVERITY_ORDER = { info: 1, viktig: 2, kritisk: 3 };

export const ALERT_LEVELS = {
  kritisk: 3,
  viktig: 2,
  alle: 1,
};

/** Skal denne hendelsen sendes til en konto med dette varslingsnivået? */
export function passesAlertLevel(severity, alertLevel) {
  const min = ALERT_LEVELS[alertLevel] ?? ALERT_LEVELS.viktig;
  return (SEVERITY_ORDER[severity] ?? 1) >= min;
}

export const EVENT_TYPES = {
  SLETTET: { severity: 'kritisk', tekst: 'Slettet fra Enhetsregisteret' },
  KONKURS: { severity: 'kritisk', tekst: 'Konkurs registrert' },
  TVANGSAVVIKLING: { severity: 'kritisk', tekst: 'Under tvangsavvikling eller tvangsoppløsning' },
  UNDER_AVVIKLING: { severity: 'viktig', tekst: 'Under avvikling' },
  KONKURS_OPPHEVET: { severity: 'viktig', tekst: 'Konkursregistrering opphevet' },
  TVANGSAVVIKLING_OPPHEVET: { severity: 'viktig', tekst: 'Tvangsavvikling opphevet' },
  AVVIKLING_AVSLUTTET: { severity: 'viktig', tekst: 'Avvikling avsluttet' },
  GJENOPPRETTET: { severity: 'viktig', tekst: 'Gjenopprettet i Enhetsregisteret' },
  NAVN_ENDRET: { severity: 'viktig', tekst: 'Navn endret' },
  ORGANISASJONSFORM_ENDRET: { severity: 'viktig', tekst: 'Organisasjonsform endret' },
  MVA_AVREGISTRERT: { severity: 'viktig', tekst: 'Slettet fra Merverdiavgiftsregisteret' },
  MVA_REGISTRERT: { severity: 'info', tekst: 'Registrert i Merverdiavgiftsregisteret' },
  ADRESSE_ENDRET: { severity: 'info', tekst: 'Forretningsadresse endret' },
  POSTADRESSE_ENDRET: { severity: 'info', tekst: 'Postadresse endret' },
  NAERINGSKODE_ENDRET: { severity: 'info', tekst: 'Næringskode endret' },
  ANSATTE_ENDRET: { severity: 'info', tekst: 'Antall ansatte endret' },
};

function text(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

function bool(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return false;
}

function joinAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const lines = Array.isArray(address.adresse)
    ? address.adresse.filter(Boolean)
    : [address.adresse].filter(Boolean);
  const parts = [
    lines.join(', ') || null,
    [text(address.postnummer), text(address.poststed)].filter(Boolean).join(' ') || null,
    text(address.kommune),
    text(address.land) && text(address.land).toLowerCase() !== 'norge' ? text(address.land) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Reduserer et rått Brreg-enhetsobjekt til feltene vi faktisk overvåker.
 * Bevisst utelatt: styremedlemmer, daglig leder og andre roller — det er
 * personopplysninger vi ikke trenger og ikke vil lagre.
 */
export function normalizeEntity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const orgform = raw.organisasjonsform || {};
  const naering = raw.naeringskode1 || {};
  return {
    orgnr: text(raw.organisasjonsnummer),
    navn: text(raw.navn),
    organisasjonsform: text(orgform.kode),
    organisasjonsformTekst: text(orgform.beskrivelse),
    naeringskode: text(naering.kode),
    naeringskodeTekst: text(naering.beskrivelse),
    forretningsadresse: joinAddress(raw.forretningsadresse),
    postadresse: joinAddress(raw.postadresse),
    antallAnsatte:
      raw.antallAnsatte === null || raw.antallAnsatte === undefined
        ? null
        : Number(raw.antallAnsatte),
    konkurs: bool(raw.konkurs),
    underAvvikling: bool(raw.underAvvikling),
    underTvangsavvikling: bool(raw.underTvangsavviklingEllerTvangsopplosning),
    mvaRegistrert: bool(raw.registrertIMvaregisteret),
    slettedato: text(raw.slettedato),
    slettet: Boolean(text(raw.slettedato)),
  };
}

/** Snapshot for en enhet Brreg svarer 410 Gone på. */
export function deletedSnapshot(orgnr, previous, slettedato = null) {
  return {
    ...(previous || {}),
    orgnr: text(orgnr),
    navn: previous ? previous.navn : null,
    slettet: true,
    slettedato: slettedato || (previous && previous.slettedato) || null,
  };
}

function push(events, type, { felt = null, fra = null, til = null } = {}) {
  const meta = EVENT_TYPES[type];
  if (!meta) throw new Error(`Ukjent hendelsestype: ${type}`);
  events.push({
    type,
    severity: meta.severity,
    tekst: meta.tekst,
    felt,
    fra: fra === null || fra === undefined ? null : String(fra),
    til: til === null || til === undefined ? null : String(til),
  });
}

function flagChange(events, before, after, key, onTrue, onFalse) {
  const was = Boolean(before[key]);
  const now = Boolean(after[key]);
  if (was === now) return;
  const type = now ? onTrue : onFalse;
  if (!type) return;
  push(events, type, { felt: key, fra: was ? 'ja' : 'nei', til: now ? 'ja' : 'nei' });
}

function fieldChange(events, before, after, key, type, felt) {
  const fra = before[key] ?? null;
  const til = after[key] ?? null;
  if (fra === til) return;
  if (fra === null && til === null) return;
  push(events, type, { felt, fra, til });
}

/**
 * Sammenlikner to normaliserte snapshots og returnerer hendelsene mellom dem.
 * Ren funksjon uten sideeffekter — hele varslingskvaliteten hviler på denne.
 */
export function diffEntities(before, after) {
  const events = [];
  if (!after) return events;

  // Førstegangsregistrering gir ingen hendelser; vi har ikke noe å sammenlikne
  // med, og kunden skal ikke få en flom av "endringer" når de legger til et
  // selskap.
  if (!before) return events;

  // Sletting og gjenoppretting overstyrer alt annet: når en enhet er borte har
  // det ingen mening å rapportere at adressen også endret seg.
  if (!before.slettet && after.slettet) {
    push(events, 'SLETTET', { felt: 'slettedato', fra: null, til: after.slettedato });
    return events;
  }
  if (before.slettet && !after.slettet) {
    push(events, 'GJENOPPRETTET', { felt: 'slettedato', fra: before.slettedato, til: null });
  }

  flagChange(events, before, after, 'konkurs', 'KONKURS', 'KONKURS_OPPHEVET');
  flagChange(
    events, before, after, 'underTvangsavvikling',
    'TVANGSAVVIKLING', 'TVANGSAVVIKLING_OPPHEVET',
  );
  flagChange(events, before, after, 'underAvvikling', 'UNDER_AVVIKLING', 'AVVIKLING_AVSLUTTET');
  flagChange(events, before, after, 'mvaRegistrert', 'MVA_REGISTRERT', 'MVA_AVREGISTRERT');

  fieldChange(events, before, after, 'navn', 'NAVN_ENDRET', 'navn');
  fieldChange(
    events, before, after, 'organisasjonsform',
    'ORGANISASJONSFORM_ENDRET', 'organisasjonsform',
  );
  fieldChange(events, before, after, 'forretningsadresse', 'ADRESSE_ENDRET', 'forretningsadresse');
  fieldChange(events, before, after, 'postadresse', 'POSTADRESSE_ENDRET', 'postadresse');
  fieldChange(events, before, after, 'naeringskode', 'NAERINGSKODE_ENDRET', 'naeringskode');

  if ((before.antallAnsatte ?? null) !== (after.antallAnsatte ?? null)) {
    push(events, 'ANSATTE_ENDRET', {
      felt: 'antallAnsatte',
      fra: before.antallAnsatte,
      til: after.antallAnsatte,
    });
  }

  return events;
}

/** Stabil nøkkel som hindrer at samme hendelse lagres to ganger samme dag. */
export function dedupKey(orgnr, event, when = new Date()) {
  const day = when.toISOString().slice(0, 10);
  const material = [orgnr, event.type, event.fra ?? '', event.til ?? '', day].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** Én setning på norsk, brukt i e-post, webhook og grensesnitt. */
export function describeEvent(event) {
  const meta = EVENT_TYPES[event.type];
  const tekst = (meta && meta.tekst) || event.type;
  const fra = event.fra_verdi ?? event.fra ?? null;
  const til = event.til_verdi ?? event.til ?? null;

  switch (event.type) {
    case 'SLETTET':
      return til ? `Slettet fra Enhetsregisteret ${til}` : 'Slettet fra Enhetsregisteret';
    case 'KONKURS':
      return 'Konkurs er registrert';
    case 'TVANGSAVVIKLING':
      return 'Registrert under tvangsavvikling eller tvangsoppløsning';
    case 'UNDER_AVVIKLING':
      return 'Registrert under avvikling';
    case 'MVA_REGISTRERT':
      return 'Registrert i Merverdiavgiftsregisteret';
    case 'MVA_AVREGISTRERT':
      return 'Slettet fra Merverdiavgiftsregisteret';
    case 'ANSATTE_ENDRET':
      return `Antall ansatte endret fra ${fra ?? 'ukjent'} til ${til ?? 'ukjent'}`;
    default:
      if (fra && til) return `${tekst}: ${fra} → ${til}`;
      if (til) return `${tekst}: ${til}`;
      return tekst;
  }
}
