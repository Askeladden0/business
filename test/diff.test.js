import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEntity, diffEntities, deletedSnapshot, dedupKey, describeEvent,
  passesAlertLevel, EVENT_TYPES,
} from '../src/diff.js';

const RAW = {
  organisasjonsnummer: '812345672',
  navn: 'TESTBEDRIFT AS',
  organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
  naeringskode1: { kode: '62.010', beskrivelse: 'Programmering' },
  antallAnsatte: 12,
  forretningsadresse: {
    adresse: ['Storgata 1'], postnummer: '0155', poststed: 'OSLO',
    kommune: 'OSLO', land: 'Norge',
  },
  konkurs: false,
  underAvvikling: false,
  underTvangsavviklingEllerTvangsopplosning: false,
  registrertIMvaregisteret: true,
};

test('normaliserer en enhet til feltene vi overvåker', () => {
  const entity = normalizeEntity(RAW);
  assert.equal(entity.orgnr, '812345672');
  assert.equal(entity.navn, 'TESTBEDRIFT AS');
  assert.equal(entity.organisasjonsform, 'AS');
  assert.equal(entity.forretningsadresse, 'Storgata 1, 0155 OSLO, OSLO');
  assert.equal(entity.konkurs, false);
  assert.equal(entity.mvaRegistrert, true);
  assert.equal(entity.slettet, false);
});

test('lagrer ikke personopplysninger om roller', () => {
  const entity = normalizeEntity({
    ...RAW,
    styre: [{ navn: 'Kari Nordmann', fodselsdato: '1980-01-01' }],
    dagligLeder: 'Ola Nordmann',
  });
  const serialized = JSON.stringify(entity);
  assert.ok(!serialized.includes('Kari'), 'styremedlemmer skal ikke lagres');
  assert.ok(!serialized.includes('Ola'), 'daglig leder skal ikke lagres');
  assert.ok(!('styre' in entity));
  assert.ok(!('dagligLeder' in entity));
});

test('første observasjon gir ingen hendelser', () => {
  assert.deepEqual(diffEntities(null, normalizeEntity(RAW)), []);
});

test('ingen endring gir ingen hendelser', () => {
  const entity = normalizeEntity(RAW);
  assert.deepEqual(diffEntities(entity, { ...entity }), []);
});

test('konkurs gir kritisk hendelse', () => {
  const before = normalizeEntity(RAW);
  const after = normalizeEntity({ ...RAW, konkurs: true });
  const events = diffEntities(before, after);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'KONKURS');
  assert.equal(events[0].severity, 'kritisk');
});

test('konkurs som oppheves gir egen hendelse', () => {
  const before = normalizeEntity({ ...RAW, konkurs: true });
  const after = normalizeEntity(RAW);
  const events = diffEntities(before, after);
  assert.equal(events[0].type, 'KONKURS_OPPHEVET');
  assert.equal(events[0].severity, 'viktig');
});

test('tvangsavvikling og avvikling skilles fra hverandre', () => {
  const before = normalizeEntity(RAW);
  assert.equal(
    diffEntities(before, normalizeEntity({ ...RAW, underTvangsavviklingEllerTvangsopplosning: true }))[0].type,
    'TVANGSAVVIKLING',
  );
  assert.equal(
    diffEntities(before, normalizeEntity({ ...RAW, underAvvikling: true }))[0].type,
    'UNDER_AVVIKLING',
  );
});

test('sletting overstyrer alle andre endringer', () => {
  const before = normalizeEntity(RAW);
  const after = deletedSnapshot('812345672', before, '2026-08-15');
  after.navn = 'HELT NYTT NAVN';
  after.antallAnsatte = 0;
  const events = diffEntities(before, after);
  assert.equal(events.length, 1, 'kun sletting skal rapporteres');
  assert.equal(events[0].type, 'SLETTET');
  assert.equal(events[0].til, '2026-08-15');
});

test('gjenoppretting rapporteres', () => {
  const before = deletedSnapshot('812345672', normalizeEntity(RAW), '2026-08-15');
  const after = normalizeEntity(RAW);
  const types = diffEntities(before, after).map((e) => e.type);
  assert.ok(types.includes('GJENOPPRETTET'));
});

test('flere samtidige endringer rapporteres hver for seg', () => {
  const before = normalizeEntity(RAW);
  const after = normalizeEntity({
    ...RAW,
    navn: 'NYTT NAVN AS',
    antallAnsatte: 3,
    registrertIMvaregisteret: false,
    forretningsadresse: { ...RAW.forretningsadresse, adresse: ['Nygata 9'] },
  });
  const types = diffEntities(before, after).map((e) => e.type).sort();
  assert.deepEqual(types, ['ADRESSE_ENDRET', 'ANSATTE_ENDRET', 'MVA_AVREGISTRERT', 'NAVN_ENDRET']);
});

test('MVA-sletting er viktigere enn MVA-registrering', () => {
  assert.equal(EVENT_TYPES.MVA_AVREGISTRERT.severity, 'viktig');
  assert.equal(EVENT_TYPES.MVA_REGISTRERT.severity, 'info');
});

test('varslingsnivå filtrerer riktig', () => {
  assert.equal(passesAlertLevel('kritisk', 'kritisk'), true);
  assert.equal(passesAlertLevel('viktig', 'kritisk'), false);
  assert.equal(passesAlertLevel('info', 'kritisk'), false);

  assert.equal(passesAlertLevel('kritisk', 'viktig'), true);
  assert.equal(passesAlertLevel('viktig', 'viktig'), true);
  assert.equal(passesAlertLevel('info', 'viktig'), false);

  assert.equal(passesAlertLevel('info', 'alle'), true);
  assert.equal(passesAlertLevel('kritisk', 'alle'), true);
});

test('dedup-nøkkelen er stabil samme dag og ulik mellom dager', () => {
  const event = { type: 'KONKURS', fra: 'nei', til: 'ja' };
  const dag1 = new Date('2026-08-31T10:00:00Z');
  const dag1senere = new Date('2026-08-31T23:00:00Z');
  const dag2 = new Date('2026-09-01T01:00:00Z');
  assert.equal(dedupKey('812345672', event, dag1), dedupKey('812345672', event, dag1senere));
  assert.notEqual(dedupKey('812345672', event, dag1), dedupKey('812345672', event, dag2));
  assert.notEqual(dedupKey('812345672', event, dag1), dedupKey('999888771', event, dag1));
});

test('beskrivelsene er lesbare på norsk', () => {
  assert.equal(describeEvent({ type: 'KONKURS' }), 'Konkurs er registrert');
  assert.equal(
    describeEvent({ type: 'NAVN_ENDRET', fra: 'A AS', til: 'B AS' }),
    'Navn endret: A AS → B AS',
  );
  assert.equal(
    describeEvent({ type: 'ANSATTE_ENDRET', fra_verdi: '10', til_verdi: '4' }),
    'Antall ansatte endret fra 10 til 4',
  );
  // Alle typer skal ha en beskrivelse, ingen skal falle tilbake til råkoden.
  for (const type of Object.keys(EVENT_TYPES)) {
    const text = describeEvent({ type, fra: 'x', til: 'y' });
    assert.ok(text && text !== type, `${type} mangler beskrivelse`);
  }
});

test('tåler manglende og uventede felter uten å kaste', () => {
  assert.equal(normalizeEntity(null), null);
  assert.equal(normalizeEntity(undefined), null);
  const sparse = normalizeEntity({ organisasjonsnummer: '812345672' });
  assert.equal(sparse.navn, null);
  assert.equal(sparse.konkurs, false);
  assert.deepEqual(diffEntities(sparse, sparse), []);
});
