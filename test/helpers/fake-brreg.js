import { createServer } from 'node:http';

/**
 * Etterlikner Brregs åpne API så tett som dokumentasjonen tillater, slik at
 * hele pollesløyfen kan kjøres uten nett. Innholdet styres fra testene.
 */
export function createFakeBrreg() {
  const state = {
    entities: new Map(),   // orgnr -> rå enhet, eller { __gone: true }
    updates: [],           // { oppdateringsid, dato, organisasjonsnummer, endringstype }
    requests: [],
    failNext: 0,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    state.requests.push(url.pathname + url.search);

    if (state.failNext > 0) {
      state.failNext -= 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"melding":"tjenesten er nede"}');
      return;
    }

    if (url.pathname === '/oppdateringer/enheter') {
      const size = Number(url.searchParams.get('size') || 100);
      const fromId = url.searchParams.get('oppdateringsid');
      const dato = url.searchParams.get('dato');

      let items = state.updates;
      if (fromId !== null) {
        // Brreg leverer oppdateringer fra og med den oppgitte id-en.
        items = items.filter((u) => u.oppdateringsid >= Number(fromId));
      } else if (dato) {
        items = items.filter((u) => u.dato >= dato);
      }
      const page = items.slice(0, size);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        _embedded: { oppdaterteEnheter: page },
        _links: { self: { href: url.pathname } },
        page: { size, totalElements: items.length, totalPages: Math.ceil(items.length / size), number: 0 },
      }));
      return;
    }

    const entityMatch = url.pathname.match(/^\/enheter\/(\d+)$/);
    if (entityMatch) {
      const orgnr = entityMatch[1];
      const entity = state.entities.get(orgnr);
      if (!entity) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"melding":"Ingen treff"}');
        return;
      }
      if (entity.__gone) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          organisasjonsnummer: orgnr,
          slettedato: entity.slettedato || '2026-08-01',
          respons_klasse: 'Slettet',
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entity));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"melding":"ukjent sti"}');
  });

  return {
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    setEntity(orgnr, fields = {}) {
      state.entities.set(orgnr, {
        organisasjonsnummer: orgnr,
        navn: `TESTBEDRIFT ${orgnr}`,
        organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
        registreringsdatoEnhetsregisteret: '2015-01-01',
        naeringskode1: { kode: '62.010', beskrivelse: 'Programmeringstjenester' },
        antallAnsatte: 10,
        forretningsadresse: {
          adresse: ['Storgata 1'], postnummer: '0155', poststed: 'OSLO',
          kommune: 'OSLO', kommunenummer: '0301', land: 'Norge', landkode: 'NO',
        },
        konkurs: false,
        underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false,
        registrertIMvaregisteret: true,
        ...fields,
      });
    },
    patchEntity(orgnr, fields) {
      const current = state.entities.get(orgnr) || {};
      state.entities.set(orgnr, { ...current, ...fields });
    },
    markGone(orgnr, slettedato = '2026-08-15') {
      state.entities.set(orgnr, { __gone: true, slettedato });
    },
    pushUpdate(orgnr, { endringstype = 'Endring', dato = new Date().toISOString() } = {}) {
      const oppdateringsid = state.updates.length
        ? Math.max(...state.updates.map((u) => u.oppdateringsid)) + 1
        : 1000;
      state.updates.push({ oppdateringsid, dato, organisasjonsnummer: orgnr, endringstype });
      return oppdateringsid;
    },
  };
}
