import Stripe from 'stripe';
import { config } from './config.js';
import { log } from './log.js';
import { getDb } from './db.js';
import { PLANS, planFromPriceId, getPlan } from './plans.js';
import {
  ensureAccount, findAccountByEmail, findAccountByStripeCustomer, findAccountById, updateAccount,
  normalizeEmail,
} from './accounts.js';
import { createMagicLink } from './auth.js';
import { sendMail } from './mailer.js';
import { welcomeEmail, paymentFailedEmail, subscriptionEndedEmail } from './emails.js';

let client = null;

export function getStripe() {
  if (client) return client;
  if (!config.stripe.secretKey) {
    throw new Error('STRIPE_SECRET_KEY mangler — betaling er ikke konfigurert');
  }
  client = new Stripe(config.stripe.secretKey, { apiVersion: '2025-09-30.clover' });
  return client;
}

/** Byttes ut i tester med en attrapp. */
export function setStripeClient(fake) {
  client = fake;
}

export function stripeConfigured() {
  return Boolean(config.stripe.secretKey && config.stripe.prices.solo && config.stripe.prices.byraa);
}

export async function createCheckoutSession({ email, planId }) {
  const plan = PLANS[planId];
  if (!plan || plan.prisNok === 0) throw new Error(`Ukjent betalt plan: ${planId}`);
  const price = config.stripe.prices[planId];
  if (!price) throw new Error(`Mangler Stripe-pris for plan ${planId}`);

  const existing = findAccountByEmail(email);
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    success_url: `${config.baseUrl}/velkommen?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/#priser`,
    client_reference_id: normalizeEmail(email),
    ...(existing && existing.stripe_customer_id
      ? { customer: existing.stripe_customer_id }
      : { customer_email: normalizeEmail(email) }),
    allow_promotion_codes: true,
    subscription_data: {
      ...(config.stripe.trialDays > 0 ? { trial_period_days: config.stripe.trialDays } : {}),
      metadata: { plan: planId },
    },
    metadata: { plan: planId, email: normalizeEmail(email) },
  });
  return session;
}

export async function createPortalSession(customerId) {
  return getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${config.baseUrl}/app/innstillinger`,
  });
}

export function constructEvent(rawBody, signature) {
  return getStripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

function alreadyHandled(eventId) {
  return Boolean(getDb().prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(eventId));
}

function markHandled(eventId, type) {
  getDb()
    .prepare('INSERT INTO stripe_events (id, type) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
    .run(eventId, type);
}

function priceIdFromSubscription(subscription) {
  const item = subscription && subscription.items && subscription.items.data && subscription.items.data[0];
  if (!item) return null;
  return (item.price && item.price.id) || null;
}

function periodEndIso(subscription) {
  const item = subscription && subscription.items && subscription.items.data && subscription.items.data[0];
  const seconds = (item && item.current_period_end) || subscription.current_period_end;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function statusFromStripe(stripeStatus) {
  if (['active', 'trialing'].includes(stripeStatus)) return 'active';
  if (['past_due', 'unpaid', 'incomplete'].includes(stripeStatus)) return 'past_due';
  return 'canceled';
}

async function applySubscription(account, subscription) {
  const priceId = priceIdFromSubscription(subscription);
  const planId = planFromPriceId(priceId, config.stripe.prices);
  const status = statusFromStripe(subscription.status);

  return updateAccount(account.id, {
    // Ved oppsigelse beholdes ikke den betalte planen, men vaktlisten røres ikke.
    plan: status === 'canceled' ? 'gratis' : planId || account.plan,
    status,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customer || account.stripe_customer_id,
    current_period_end: periodEndIso(subscription),
  });
}

function resolveAccount({ email, customerId }) {
  if (customerId) {
    const byCustomer = findAccountByStripeCustomer(customerId);
    if (byCustomer) return byCustomer;
  }
  if (email) {
    const account = ensureAccount(email, { stripe_customer_id: customerId || null });
    if (customerId && !account.stripe_customer_id) {
      return updateAccount(account.id, { stripe_customer_id: customerId });
    }
    return account;
  }
  return null;
}

/**
 * Én inngang for alle Stripe-hendelser. Idempotent: samme event-id behandles
 * bare én gang, slik at Stripes gjentatte leveringer ikke gir dobbelt
 * velkomstbrev eller feil plan.
 */
export async function handleStripeEvent(event) {
  if (alreadyHandled(event.id)) {
    log.info('stripe-hendelse allerede behandlet', { id: event.id, type: event.type });
    return { skipped: true };
  }

  const object = event.data && event.data.object;
  let outcome = { type: event.type };

  switch (event.type) {
    case 'checkout.session.completed': {
      const email = normalizeEmail(
        object.customer_email ||
          (object.customer_details && object.customer_details.email) ||
          object.client_reference_id ||
          (object.metadata && object.metadata.email),
      );
      const customerId = typeof object.customer === 'string' ? object.customer : null;
      const account = resolveAccount({ email, customerId });
      if (!account) {
        log.error('checkout uten e-post eller kunde-id', { id: event.id });
        outcome = { ...outcome, error: 'ingen konto kunne opprettes' };
        break;
      }

      let planId = (object.metadata && object.metadata.plan) || null;
      let updated = account;

      const subscriptionId =
        typeof object.subscription === 'string' ? object.subscription : null;
      if (subscriptionId) {
        try {
          const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
          updated = await applySubscription(
            customerId ? updateAccount(account.id, { stripe_customer_id: customerId }) : account,
            subscription,
          );
          planId = updated.plan;
        } catch (err) {
          log.error('kunne ikke hente abonnement fra Stripe', { err, subscriptionId });
          updated = updateAccount(account.id, {
            plan: planId || 'solo',
            status: 'active',
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
          });
        }
      }

      const link = createMagicLink(updated.email);
      const mail = welcomeEmail({ url: link.url, planNavn: getPlan(updated.plan).navn });
      await sendMail({ to: updated.email, ...mail, kind: 'velkommen' });
      outcome = { ...outcome, accountId: updated.id, plan: updated.plan };
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const account = resolveAccount({ customerId: object.customer });
      if (!account) break;
      const updated = await applySubscription(account, object);
      outcome = { ...outcome, accountId: updated.id, plan: updated.plan, status: updated.status };
      break;
    }

    case 'customer.subscription.deleted': {
      const account = resolveAccount({ customerId: object.customer });
      if (!account) break;
      updateAccount(account.id, {
        plan: 'gratis',
        status: 'canceled',
        stripe_subscription_id: null,
      });
      await sendMail({ to: account.email, ...subscriptionEndedEmail(), kind: 'oppsagt' });
      outcome = { ...outcome, accountId: account.id, plan: 'gratis' };
      break;
    }

    case 'invoice.payment_failed': {
      const account = resolveAccount({ customerId: object.customer });
      if (!account) break;
      updateAccount(account.id, { status: 'past_due' });
      let url = `${config.baseUrl}/app/innstillinger`;
      try {
        if (account.stripe_customer_id) {
          const portal = await createPortalSession(account.stripe_customer_id);
          url = portal.url;
        }
      } catch (err) {
        log.warn('kunne ikke lage portallenke til betalingsfeil', { err });
      }
      await sendMail({ to: account.email, ...paymentFailedEmail({ url }), kind: 'betaling-feilet' });
      outcome = { ...outcome, accountId: account.id, status: 'past_due' };
      break;
    }

    case 'invoice.payment_succeeded': {
      const account = resolveAccount({ customerId: object.customer });
      if (account && account.status === 'past_due') {
        updateAccount(account.id, { status: 'active' });
        outcome = { ...outcome, accountId: account.id, status: 'active' };
      }
      break;
    }

    default:
      outcome = { ...outcome, ignored: true };
  }

  markHandled(event.id, event.type);
  return outcome;
}

export { findAccountById };
