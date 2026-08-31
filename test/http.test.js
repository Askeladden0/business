import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.js';
import { parseForm, parseJson, cookies, rateLimit, resetRateLimits, sameOrigin, HttpError } from '../src/http.js';
import { config } from '../src/config.js';
import { safeEqual } from '../src/auth.js';

test('ruteren matcher faste stier og parametere', () => {
  const router = createRouter();
  router.get('/', () => 'rot');
  router.get('/app/vakter/:orgnr', () => 'vakt');
  router.post('/app/vakter', () => 'ny');

  assert.ok(router.match('GET', '/'));
  assert.deepEqual(router.match('GET', '/app/vakter/812345672').params, { orgnr: '812345672' });
  assert.ok(router.match('POST', '/app/vakter'));
  assert.equal(router.match('GET', '/finnes/ikke'), null);
});

test('HEAD behandles som GET', () => {
  const router = createRouter();
  router.get('/healthz', () => 'ok');
  assert.ok(router.match('HEAD', '/healthz'));
});

test('feil metode på kjent sti gir 405, ikke 404', () => {
  const router = createRouter();
  router.get('/healthz', () => 'ok');
  assert.throws(() => router.match('POST', '/healthz'), (err) => err.status === 405);
});

test('skjemadata tolkes, også med gjentatte felter', () => {
  const form = parseForm(Buffer.from('a=1&b=to+ord&b=tre&tom='));
  assert.equal(form.a, '1');
  assert.deepEqual(form.b, ['to ord', 'tre']);
  assert.equal(form.tom, '');
});

test('JSON-kropp tolkes og ugyldig JSON gir 400', () => {
  assert.deepEqual(parseJson(Buffer.from('{"a":1}')), { a: 1 });
  assert.deepEqual(parseJson(Buffer.alloc(0)), {});
  assert.throws(() => parseJson(Buffer.from('{ikke json')), (err) => err.status === 400);
});

test('informasjonskapsler tolkes', () => {
  const jar = cookies({ headers: { cookie: 'rv_session=abc123; annen=verdi' } });
  assert.equal(jar.rv_session, 'abc123');
  assert.equal(jar.annen, 'verdi');
  assert.deepEqual(cookies({ headers: {} }), {});
});

test('takstbegrensning slipper gjennom inntil grensen', () => {
  resetRateLimits();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(rateLimit('nokkel', { max: 5 }).ok, true, `forsøk ${i + 1}`);
  }
  const blokkert = rateLimit('nokkel', { max: 5 });
  assert.equal(blokkert.ok, false);
  assert.ok(blokkert.retryAfterSeconds > 0);
  // Andre nøkler påvirkes ikke.
  assert.equal(rateLimit('annen-nokkel', { max: 5 }).ok, true);
});

test('opphavssjekk godtar egen origin og navigasjon uten origin', () => {
  const original = config.baseUrl;
  config.baseUrl = 'https://registervakt.no';
  assert.equal(sameOrigin({ headers: {} }), true, 'vanlig navigasjon sender ingen Origin');
  assert.equal(sameOrigin({ headers: { origin: 'https://registervakt.no' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'https://ondsinnet.example' } }), false);
  assert.equal(sameOrigin({ headers: { origin: 'ikke-en-url' } }), false);
  config.baseUrl = original;
});

test('hemmeligheter sammenliknes i konstant tid og korrekt', () => {
  assert.equal(safeEqual('hemmelig', 'hemmelig'), true);
  assert.equal(safeEqual('hemmelig', 'hemmeliG'), false);
  assert.equal(safeEqual('kort', 'mye-lengre-streng'), false);
  assert.equal(safeEqual(null, undefined), true, 'tomme verdier er like — kallende kode må sjekke tomhet');
  assert.equal(safeEqual('noe', null), false);
});

test('HttpError bærer statuskode', () => {
  const err = new HttpError(413, 'for stor');
  assert.equal(err.status, 413);
  assert.equal(err.message, 'for stor');
});
