import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidOrgnr, normalizeOrgnr, formatOrgnr, parseOrgnrList } from '../src/orgnr.js';

test('godtar gyldige organisasjonsnumre', () => {
  for (const orgnr of ['923609016', '974760673', '812345672', '999888771']) {
    assert.equal(isValidOrgnr(orgnr), true, `${orgnr} skulle vært gyldig`);
  }
});

test('avviser ugyldig kontrollsiffer', () => {
  assert.equal(isValidOrgnr('923609017'), false);
  assert.equal(isValidOrgnr('123456789'), false);
});

test('avviser feil lengde og ikke-siffer', () => {
  for (const value of ['', '12345678', '1234567890', 'abcdefghi', null, undefined, '92360901a']) {
    assert.equal(isValidOrgnr(value), false, `${value} skulle vært ugyldig`);
  }
});

test('avviser nummer der kontrollsifferet ville blitt 10', () => {
  // Rest 1 i mod-11 gir kontrollsiffer 10, som ikke kan skrives med ett siffer.
  const funnet = [];
  for (let base = 0; base < 200; base += 1) {
    const prefix = String(100000000 + base).slice(0, 8);
    const weights = [3, 2, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 8; i += 1) sum += Number(prefix[i]) * weights[i];
    if (sum % 11 === 1) funnet.push(prefix);
  }
  assert.ok(funnet.length > 0, 'testen trenger minst ett slikt tilfelle');
  for (const prefix of funnet) {
    for (let d = 0; d <= 9; d += 1) {
      assert.equal(isValidOrgnr(`${prefix}${d}`), false);
    }
  }
});

test('normaliserer formatering', () => {
  assert.equal(normalizeOrgnr('923 609 016'), '923609016');
  assert.equal(normalizeOrgnr('923-609-016'), '923609016');
  assert.equal(normalizeOrgnr('923.609.016'), '923609016');
  assert.equal(isValidOrgnr('923 609 016'), true);
});

test('formaterer for visning', () => {
  assert.equal(formatOrgnr('923609016'), '923 609 016');
  assert.equal(formatOrgnr('tull'), 'tull');
});

test('plukker organisasjonsnumre ut av CSV med overskrift og flere kolonner', () => {
  const csv = [
    'orgnr;navn;kontakt',
    '923 609 016;Equinor ASA;post@equinor.no',
    '"974760673";Statsbygg;',
    '812345672,Testbedrift',
  ].join('\n');
  const { valid, invalid } = parseOrgnrList(csv);
  assert.deepEqual(valid.sort(), ['812345672', '923609016', '974760673']);
  assert.deepEqual(invalid, []);
});

test('rapporterer ugyldige numre i stedet for å svelge dem', () => {
  const { valid, invalid } = parseOrgnrList('923609016\n123456789\n99999');
  assert.deepEqual(valid, ['923609016']);
  assert.ok(invalid.includes('123456789'), 'ugyldig kontrollsiffer skal rapporteres');
  assert.ok(invalid.includes('99999'), 'for kort nummer skal rapporteres');
});

test('fjerner duplikater', () => {
  const { valid } = parseOrgnrList('923609016\n923 609 016\n923609016');
  assert.deepEqual(valid, ['923609016']);
});

test('tåler tom og useriøs inndata', () => {
  assert.deepEqual(parseOrgnrList(''), { valid: [], invalid: [] });
  assert.deepEqual(parseOrgnrList(null), { valid: [], invalid: [] });
  assert.deepEqual(parseOrgnrList('bare tekst uten tall'), { valid: [], invalid: [] });
});
