import { config } from './config.js';
import { log } from './log.js';

export class BrregError extends Error {
  constructor(message, { status, url, cause } = {}) {
    super(message);
    this.name = 'BrregError';
    this.status = status;
    this.url = url;
    if (cause) this.cause = cause;
  }
}

/** Enheten finnes ikke lenger i registeret (Brreg svarer 410 Gone). */
export class EntityGoneError extends BrregError {
  constructor(orgnr, body) {
    super(`Enhet ${orgnr} er slettet fra Enhetsregisteret`, { status: 410 });
    this.name = 'EntityGoneError';
    this.orgnr = orgnr;
    this.body = body;
  }
}

export class EntityNotFoundError extends BrregError {
  constructor(orgnr) {
    super(`Fant ikke enhet ${orgnr} i Enhetsregisteret`, { status: 404 });
    this.name = 'EntityNotFoundError';
    this.orgnr = orgnr;
  }
}

async function request(path, { baseUrl = config.brreg.baseUrl, timeoutMs = config.brreg.timeoutMs } = {}) {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': config.brreg.userAgent,
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new BrregError(`Nettverksfeil mot Brreg: ${err.message}`, { url, cause: err });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { response, body, text, url };
}

/**
 * Brreg-responsene bruker HAL. Vi vet at listen ligger under `_embedded`, men
 * ikke garantert under hvilket nøkkelnavn på tvers av endepunkter og
 * API-versjoner. Derfor plukker vi første array i `_embedded` som fallback.
 */
export function extractEmbeddedList(body, preferredKeys = []) {
  if (!body || typeof body !== 'object') return [];
  const embedded = body._embedded;
  if (!embedded || typeof embedded !== 'object') {
    return Array.isArray(body) ? body : [];
  }
  for (const key of preferredKeys) {
    if (Array.isArray(embedded[key])) return embedded[key];
  }
  for (const value of Object.values(embedded)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Leser sidetall fra HAL-`page`-objektet. */
export function extractPageInfo(body) {
  const page = body && body.page;
  if (!page || typeof page !== 'object') return { number: 0, totalPages: 1, totalElements: null };
  return {
    number: Number(page.number ?? 0),
    totalPages: Number(page.totalPages ?? 1),
    totalElements: page.totalElements === undefined ? null : Number(page.totalElements),
  };
}

/**
 * Henter én side med oppdateringer. Bruk `oppdateringsid` som markør når vi
 * har en (idempotent og hullfri), ellers `dato` ved førstegangs oppstart.
 */
export async function fetchUpdatePage({ oppdateringsid, dato, page = 0, size = config.brreg.pageSize, underenheter = false } = {}) {
  const params = new URLSearchParams();
  if (oppdateringsid !== undefined && oppdateringsid !== null) {
    params.set('oppdateringsid', String(oppdateringsid));
  } else if (dato) {
    params.set('dato', dato);
  } else {
    throw new BrregError('fetchUpdatePage krever enten oppdateringsid eller dato');
  }
  params.set('size', String(size));
  if (page) params.set('page', String(page));

  const resource = underenheter ? 'underenheter' : 'enheter';
  const { response, body, url } = await request(`/oppdateringer/${resource}?${params.toString()}`);

  if (!response.ok) {
    throw new BrregError(`Brreg svarte ${response.status} på oppdateringer`, {
      status: response.status,
      url,
    });
  }

  const items = extractEmbeddedList(body, ['oppdaterteEnheter', 'oppdaterteUnderenheter']);
  return {
    items: items.map(normalizeUpdateItem).filter((item) => item.organisasjonsnummer),
    page: extractPageInfo(body),
  };
}

function normalizeUpdateItem(item) {
  if (!item || typeof item !== 'object') return {};
  return {
    oppdateringsid: Number(item.oppdateringsid ?? item.oppdateringsId ?? 0) || null,
    dato: item.dato || item.oppdateringsdato || null,
    organisasjonsnummer: String(
      item.organisasjonsnummer || item.organisasjonsnummerEnhet || '',
    ).trim(),
    endringstype: item.endringstype || item.endringsType || 'Ukjent',
  };
}

/** Henter én enhet. Kaster EntityGoneError ved 410 og EntityNotFoundError ved 404. */
export async function fetchEntity(orgnr, { underenhet = false } = {}) {
  const resource = underenhet ? 'underenheter' : 'enheter';
  const { response, body, url } = await request(`/${resource}/${encodeURIComponent(orgnr)}`);

  if (response.status === 410) throw new EntityGoneError(orgnr, body);
  if (response.status === 404) throw new EntityNotFoundError(orgnr);
  if (!response.ok) {
    throw new BrregError(`Brreg svarte ${response.status} for enhet ${orgnr}`, {
      status: response.status,
      url,
    });
  }
  if (!body || typeof body !== 'object') {
    throw new BrregError(`Uventet svar fra Brreg for enhet ${orgnr}`, { url });
  }
  return body;
}

/** Søker etter enheter på navn. Brukes til å slå opp selskap i grensesnittet. */
export async function searchEntities(query, { size = 10 } = {}) {
  const params = new URLSearchParams({ navn: query, size: String(size) });
  const { response, body } = await request(`/enheter?${params.toString()}`);
  if (!response.ok) {
    throw new BrregError(`Brreg svarte ${response.status} på søk`, { status: response.status });
  }
  return extractEmbeddedList(body, ['enheter']);
}

/** Kjører oppgaver med begrenset parallellitet, for å være grei mot Brreg. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export { log };
