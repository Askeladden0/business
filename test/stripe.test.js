import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWorld } from './helpers/app.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { setStripeClient, handleStripeEvent } from '../src/stripe.js';
import { findAccountByEmail, ensureAccount, updateAccount } from '../src/accounts.js';
import { outbox } from '../src/mailer.js';

const PRIS_SOLO = 'price_solo_test';
const PRIS_BYRAA = 'price_byraa_test';

function fakeSubscription({ id = 'sub_1', price = PRIS_SOLO, status = 'active', customer = 'cus_1' } = {}) {
  return {
    id,
    customer,
    status,
    items: { data: [{ price: { id: price }, current_period_end: 1798761600 }] },
  };
}

async function stripeWorld() {
  const w = await setupWorld();
  config.stripe.prices.solo = PRIS_SOLO;
  config.stripe.prices.byraa = PRIS_BYRAA;
  const kall = { portal: 0 };
  setStripeClient({
    subscriptions: { retrieve: async (id) => fakeSubscription({ id }) },
    billingPortal: {
      sessions: {
        create: async () => {
          kall.portal += 1;
          return { url: 'https://billing.stripe.test/portal' };
        },
      },
    },
  });
  return { ...w, kall };
}

let n = 0;
const eventId = () => `evt_${++n}`;

test('betalt bestilling oppretter konto, setter plan og sender velkomstbrev', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  await handleStripeEvent({
    id: eventId(),
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_1',
        customer_details: { email: 'ny@kunde.no' },
        subscription: 'sub_1',
        metadata: { plan: 'solo' },
      },
    },
  });

  const account = findAccountByEmail('ny@kunde.no');
  assert.ok(account, 'kontoen skal være opprettet');
  assert.equal(account.plan, 'solo');
  assert.equal(account.status, 'active');
  assert.equal(account.stripe_customer_id, 'cus_1');
  assert.equal(account.stripe_subscription_id, 'sub_1');

  assert.equal(outbox().length, 1);
  assert.match(outbox()[0].subject, /Velkommen/i);
  assert.deepEqual(outbox()[0].to, ['ny@kunde.no']);
  assert.match(outbox()[0].text, /\/auth\/verifiser\?token=/, 'brevet skal inneholde innloggingslenke');
});

test('onboardingen krever ingen manuell handling — lenken virker', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  await handleStripeEvent({
    id: eventId(),
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_2', customer_email: 'auto@kunde.no', subscription: 'sub_2' } },
  });

  const token = outbox()[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  const { consumeMagicLink } = await import('../src/auth.js');
  assert.equal(consumeMagicLink(token), 'auto@kunde.no');
  assert.equal(consumeMagicLink(token), null, 'lenken skal bare virke én gang');
});

test('samme hendelse to ganger gir ikke dobbelt velkomstbrev', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  const event = {
    id: 'evt_gjentatt',
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_3', customer_email: 'idem@kunde.no', subscription: 'sub_3' } },
  };
  await handleStripeEvent(event);
  const result = await handleStripeEvent(event);

  assert.equal(result.skipped, true);
  assert.equal(outbox().length, 1);
});

test('oppgradering endrer plan', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  const account = ensureAccount('opp@kunde.no');
  updateAccount(account.id, { stripe_customer_id: 'cus_4', plan: 'solo' });

  await handleStripeEvent({
    id: eventId(),
    type: 'customer.subscription.updated',
    data: { object: fakeSubscription({ id: 'sub_4', customer: 'cus_4', price: PRIS_BYRAA }) },
  });

  assert.equal(findAccountByEmail('opp@kunde.no').plan, 'byraa');
});

test('oppsigelse setter kontoen til gratis og varsler kunden', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  const account = ensureAccount('slutt@kunde.no');
  updateAccount(account.id, { stripe_customer_id: 'cus_5', plan: 'byraa', stripe_subscription_id: 'sub_5' });
  outbox().length = 0;

  await handleStripeEvent({
    id: eventId(),
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_5', customer: 'cus_5', status: 'canceled', items: { data: [] } } },
  });

  const oppdatert = findAccountByEmail('slutt@kunde.no');
  assert.equal(oppdatert.plan, 'gratis');
  assert.equal(oppdatert.status, 'canceled');
  assert.equal(oppdatert.stripe_subscription_id, null);
  assert.match(outbox()[0].subject, /avsluttet/i);
});

test('feilet betaling setter past_due og sender portallenke', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  const account = ensureAccount('feil@kunde.no');
  updateAccount(account.id, { stripe_customer_id: 'cus_6', plan: 'solo' });
  outbox().length = 0;

  await handleStripeEvent({
    id: eventId(),
    type: 'invoice.payment_failed',
    data: { object: { customer: 'cus_6' } },
  });

  assert.equal(findAccountByEmail('feil@kunde.no').status, 'past_due');
  assert.equal(w.kall.portal, 1);
  assert.match(outbox()[0].subject, /betalingen/i);
  assert.match(outbox()[0].text, /billing\.stripe\.test/);
});

test('vellykket betaling etter feil setter kontoen aktiv igjen', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  const account = ensureAccount('tilbake@kunde.no');
  updateAccount(account.id, { stripe_customer_id: 'cus_7', plan: 'solo', status: 'past_due' });

  await handleStripeEvent({
    id: eventId(),
    type: 'invoice.payment_succeeded',
    data: { object: { customer: 'cus_7' } },
  });

  assert.equal(findAccountByEmail('tilbake@kunde.no').status, 'active');
});

test('prøveperiode regnes som aktiv', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  const account = ensureAccount('prove@kunde.no');
  updateAccount(account.id, { stripe_customer_id: 'cus_8' });

  await handleStripeEvent({
    id: eventId(),
    type: 'customer.subscription.updated',
    data: { object: fakeSubscription({ customer: 'cus_8', status: 'trialing' }) },
  });

  const oppdatert = findAccountByEmail('prove@kunde.no');
  assert.equal(oppdatert.status, 'active');
  assert.equal(oppdatert.plan, 'solo');
});

test('ukjente hendelsestyper ignoreres uten å kaste', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());
  const result = await handleStripeEvent({
    id: eventId(), type: 'charge.dispute.created', data: { object: {} },
  });
  assert.equal(result.ignored, true);
});

test('kunde uten kjent e-post eller kunde-id gir ikke krasj', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());
  const result = await handleStripeEvent({
    id: eventId(), type: 'checkout.session.completed', data: { object: {} },
  });
  assert.ok(result.error, 'skal rapportere at ingen konto kunne lages');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
});

test('konto gjenfinnes på kunde-id selv om e-posten er endret hos Stripe', async (t) => {
  const w = await stripeWorld();
  t.after(() => w.teardown());

  const account = ensureAccount('gammel@kunde.no');
  updateAccount(account.id, { stripe_customer_id: 'cus_9', plan: 'solo' });

  await handleStripeEvent({
    id: eventId(),
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_9', customer_email: 'ny-adresse@kunde.no', subscription: 'sub_9' } },
  });

  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1, 'ingen duplikatkonto');
  assert.ok(findAccountByEmail('gammel@kunde.no'));
});
