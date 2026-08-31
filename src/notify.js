import { createHmac } from 'node:crypto';
import { getDb } from './db.js';
import { log } from './log.js';
import { config } from './config.js';
import { sendMail } from './mailer.js';
import { alertEmail } from './emails.js';
import { describeEvent, passesAlertLevel } from './diff.js';
import { formatOrgnr } from './orgnr.js';
import { effectivePlan, effectiveDeliveryMode } from './plans.js';
import { recipientsFor } from './accounts.js';
import { accountsWatching } from './watches.js';

/**
 * Sprer nye hendelser ut til alle kontoer som følger enheten. Hver
 * (konto, hendelse) blir én rad i deliveries med status 'pending'; selve
 * utsendingen skjer i flushDeliveries. Å skille dem gjør at en e-postfeil
 * ikke mister hendelsen.
 */
export function fanOut(events) {
  if (!events.length) return { deliveries: 0, skipped: 0 };
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO deliveries (account_id, event_id, status) VALUES (?, ?, ?)
     ON CONFLICT(account_id, event_id) DO NOTHING`,
  );
  let deliveries = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const event of events) {
      for (const account of accountsWatching(event.orgnr)) {
        const wanted = passesAlertLevel(event.severity, account.alert_level);
        const status = wanted ? 'pending' : 'skipped';
        const result = insert.run(account.id, event.id, status);
        if (result.changes > 0) {
          if (wanted) deliveries += 1;
          else skipped += 1;
        }
      }
    }
  });
  tx();
  return { deliveries, skipped };
}

function pendingByAccount(deliveryModes) {
  const placeholders = deliveryModes.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT d.id AS delivery_id, d.account_id, e.*
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN accounts a ON a.id = d.account_id
       WHERE d.status = 'pending'
         AND d.attempts < 5
         AND (CASE WHEN a.plan = 'gratis' OR a.status = 'canceled' THEN 'daglig'
                   WHEN a.delivery_mode = 'daglig' THEN 'daglig'
                   ELSE 'straks' END) IN (${placeholders})
       ORDER BY d.account_id, e.occurred_at`,
    )
    .all(...deliveryModes);

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.account_id)) grouped.set(row.account_id, []);
    grouped.get(row.account_id).push(row);
  }
  return grouped;
}

function markDeliveries(ids, status, error = null) {
  if (!ids.length) return;
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE deliveries
     SET status = ?, attempts = attempts + 1, last_error = ?,
         sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END
     WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(status, error, status, id);
  });
  tx();
}

/**
 * Gratisplanen er begrenset til de tre eldste vaktene. Vi sletter ikke
 * overskytende vakter når noen sier opp — vi slutter bare å varsle om dem,
 * slik at oppsigelse ikke er destruktiv.
 */
function allowedOrgnrs(account) {
  const plan = effectivePlan(account);
  return new Set(
    getDb()
      .prepare('SELECT orgnr FROM watches WHERE account_id = ? ORDER BY id LIMIT ?')
      .all(account.id, plan.maxWatches)
      .map((row) => row.orgnr),
  );
}

async function postWebhook(account, events) {
  if (!account.webhook_url) return;
  const plan = effectivePlan(account);
  if (!plan.webhook) return;

  const lines = events.map(
    (event) => `*${event.navn || event.orgnr}* (${formatOrgnr(event.orgnr)}) — ${describeEvent(event)}`,
  );
  const payload =
    account.webhook_kind === 'json'
      ? {
          kilde: config.brand.name,
          antall: events.length,
          hendelser: events.map((event) => ({
            orgnr: event.orgnr,
            navn: event.navn,
            type: event.type,
            alvorlighet: event.severity,
            felt: event.felt,
            fra: event.fra_verdi,
            til: event.til_verdi,
            tidspunkt: event.occurred_at,
            beskrivelse: describeEvent(event),
          })),
        }
      : { text: `*${config.brand.name}*\n${lines.join('\n')}` };

  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (account.webhook_secret) {
    headers['X-Registervakt-Signature'] = `sha256=${createHmac('sha256', account.webhook_secret)
      .update(body)
      .digest('hex')}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(account.webhook_url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn('webhook feilet', { accountId: account.id, status: response.status });
    }
  } catch (err) {
    // En kundes ødelagte webhook skal aldri stoppe e-postvarslingen.
    log.warn('webhook feilet', { accountId: account.id, err: err.message });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sender ut ventende varsler. `modes` velger hvilke kontoer som er med:
 * ['straks'] etter hver polling, ['daglig'] fra den daglige jobben.
 */
export async function flushDeliveries({ modes = ['straks'] } = {}) {
  const grouped = pendingByAccount(modes);
  let sent = 0;
  let failed = 0;
  let accounts = 0;

  for (const [accountId, rows] of grouped) {
    const account = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) {
      markDeliveries(rows.map((r) => r.delivery_id), 'skipped', 'konto finnes ikke');
      continue;
    }

    const allowed = allowedOrgnrs(account);
    const over = rows.filter((row) => !allowed.has(row.orgnr));
    const toSend = rows.filter((row) => allowed.has(row.orgnr));
    if (over.length) {
      markDeliveries(over.map((r) => r.delivery_id), 'skipped', 'utenfor plangrensen');
    }
    if (!toSend.length) continue;

    accounts += 1;
    const digest = effectiveDeliveryMode(account) === 'daglig';
    const mail = alertEmail({ events: toSend, digest });
    const ids = toSend.map((row) => row.delivery_id);

    try {
      await sendMail({
        to: recipientsFor(account),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        kind: digest ? 'daglig-oppsummering' : 'varsel',
      });
      markDeliveries(ids, 'sent');
      sent += ids.length;
    } catch (err) {
      markDeliveries(ids, 'pending', err.message);
      failed += ids.length;
      log.error('kunne ikke sende varsel-e-post', { accountId, err });
    }

    await postWebhook(account, toSend);
  }

  return { accounts, sent, failed };
}

/** Leveringer som har feilet så mange ganger at de ikke prøves igjen. */
export function stuckDeliveries() {
  return getDb()
    .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending' AND attempts >= 5")
    .get().n;
}
