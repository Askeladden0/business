import { config } from '../../src/config.js';
import { resetDbForTests } from '../../src/db.js';
import { clearOutbox } from '../../src/mailer.js';
import { resetRateLimits } from '../../src/http.js';
import { createFakeBrreg } from './fake-brreg.js';

export const ORGNR = {
  a: '812345672',
  b: '999888771',
  c: '123456785',
  d: '555444338',
  e: '101010104',
  ugyldig: '123456789',
};

/**
 * Setter opp en isolert testverden: tom database, tom utboks og et falskt
 * Brreg-API. Returnerer en teardown-funksjon.
 */
export async function setupWorld({ pollIntervalMinutes = 0 } = {}) {
  resetDbForTests();
  clearOutbox();
  resetRateLimits();

  const brreg = createFakeBrreg();
  const baseUrl = await brreg.listen();
  const original = { ...config.brreg };
  config.brreg.baseUrl = baseUrl;
  config.brreg.pollIntervalMinutes = pollIntervalMinutes;
  config.mail.provider = 'console';
  config.ops.alertEmail = 'ops@test.no';
  config.ops.adminToken = 'test-admin-token';

  return {
    brreg,
    async teardown() {
      await brreg.close();
      Object.assign(config.brreg, original);
    },
  };
}

/** Starter HTTP-serveren på en ledig port og gir en enkel fetch-klient. */
export async function startTestServer() {
  const { createAppServer } = await import('../../src/server.js');
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const previousBaseUrl = config.baseUrl;
  config.baseUrl = origin;

  const client = {
    origin,
    cookie: '',
    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (client.cookie) headers.Cookie = client.cookie;
      if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      const response = await fetch(`${origin}${path}`, { ...options, headers, redirect: 'manual' });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        const pair = setCookie.split(';')[0];
        if (pair.endsWith('=')) client.cookie = '';
        else client.cookie = pair;
      }
      return response;
    },
    get: (path, options) => client.request(path, { method: 'GET', ...options }),
    post: (path, form, options = {}) =>
      client.request(path, {
        method: 'POST',
        body: typeof form === 'string' ? form : new URLSearchParams(form).toString(),
        headers: { Origin: origin, ...(options.headers || {}) },
        ...options,
      }),
  };

  return {
    client,
    async close() {
      config.baseUrl = previousBaseUrl;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Logger inn ved å hente engangslenken rett fra basen. */
export async function loginAs(client, email) {
  const { ensureAccount } = await import('../../src/accounts.js');
  const { createMagicLink } = await import('../../src/auth.js');
  const account = ensureAccount(email);
  const link = createMagicLink(account.email);
  await client.get(`/auth/verifiser?token=${link.token}`);
  return account;
}
