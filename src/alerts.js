import { createHash } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { getDb } from './db.js';
import { sendMail } from './mailer.js';

/**
 * Sender driftsvarsel til eieren, men høyst én gang per signatur per
 * nedkjølingsperiode. Poenget er at én vedvarende feil skal gi én e-post,
 * ikke én per minutt — ellers slutter man å lese dem.
 */
export async function opsAlert(signature, subject, body, { force = false } = {}) {
  const key = createHash('sha256').update(String(signature)).digest('hex').slice(0, 32);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM alert_state WHERE signature = ?').get(key);
  const cooldownMs = config.ops.alertCooldownMinutes * 60_000;

  if (!force && existing && Date.now() - new Date(existing.last_sent_at).getTime() < cooldownMs) {
    db.prepare('UPDATE alert_state SET count = count + 1 WHERE signature = ?').run(key);
    log.warn('ops-varsel undertrykt (nedkjøling)', { signature, subject });
    return { sent: false, reason: 'cooldown' };
  }

  const repeated = existing ? existing.count : 0;
  db.prepare(
    `INSERT INTO alert_state (signature, last_sent_at, count)
     VALUES (?, datetime('now'), 1)
     ON CONFLICT(signature) DO UPDATE SET last_sent_at = datetime('now'), count = 1`,
  ).run(key);

  log.error('ops-varsel', { signature, subject });

  if (!config.ops.alertEmail) return { sent: false, reason: 'ingen ALERT_EMAIL satt' };

  const suffix = repeated > 1 ? `\n\nUndertrykte gjentakelser siden forrige varsel: ${repeated - 1}` : '';
  try {
    await sendMail({
      to: config.ops.alertEmail,
      subject: `[${config.brand.name}] ${subject}`,
      text: `${body}${suffix}\n\nSignatur: ${signature}\nTid: ${new Date().toISOString()}\n`,
      html: `<pre style="font:13px ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(
        `${body}${suffix}\n\nSignatur: ${signature}\nTid: ${new Date().toISOString()}`,
      )}</pre>`,
      kind: 'ops',
    });
    return { sent: true };
  } catch (err) {
    // Hvis selve varslingen feiler har vi ingen andre kanaler; logg høyt.
    log.error('klarte ikke sende ops-varsel', { err, subject });
    return { sent: false, reason: err.message };
  }
}

/** Nullstiller nedkjøling, slik at neste feil av samme type varsles igjen. */
export function clearAlert(signature) {
  const key = createHash('sha256').update(String(signature)).digest('hex').slice(0, 32);
  getDb().prepare('DELETE FROM alert_state WHERE signature = ?').run(key);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
