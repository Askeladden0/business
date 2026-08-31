import { config } from './config.js';
import { log } from './log.js';
import { getDb } from './db.js';

const sentInTests = [];

/** Kun for tester: alle e-poster som er "sendt" via console-provideren. */
export function outbox() {
  return sentInTests;
}
export function clearOutbox() {
  sentInTests.length = 0;
}

function logMail({ recipient, subject, kind, status, error }) {
  try {
    getDb()
      .prepare(
        'INSERT INTO mail_log (recipient, subject, kind, status, error) VALUES (?, ?, ?, ?, ?)',
      )
      .run(recipient, subject || null, kind || null, status, error || null);
  } catch (err) {
    log.warn('kunne ikke logge e-post', { err });
  }
}

async function sendViaResend({ to, subject, html, text, replyTo }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.mail.timeoutMs);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.mail.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.mail.from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
        ...(replyTo || config.mail.replyTo
          ? { reply_to: replyTo || config.mail.replyTo }
          : {}),
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Resend svarte ${response.status}: ${body.slice(0, 400)}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      return { id: null };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sender én e-post. Kaster ved feil, slik at kallende kode kan bestemme om det
 * skal føre til nytt forsøk eller et ops-varsel.
 */
export async function sendMail({ to, subject, html, text, kind = 'ukjent', replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) throw new Error('sendMail: ingen mottaker');

  if (config.mail.provider === 'console') {
    sentInTests.push({ to: recipients, subject, html, text, kind });
    if (!config.isTest) {
      // I utvikling skrives hele teksten ut, slik at innloggingslenker og
      // varsler kan sjekkes uten en ekte e-postleverandør. Dette skjer aldri
      // i produksjon, der provideren er 'resend'.
      log.info('e-post (console-provider)', { to: recipients, subject, kind });
      process.stdout.write(`\n--- e-post til ${recipients.join(', ')} ---\n${text || '(ingen tekstversjon)'}\n---\n\n`);
    }
    for (const recipient of recipients) logMail({ recipient, subject, kind, status: 'console' });
    return { id: `console-${sentInTests.length}` };
  }

  try {
    const result = await sendViaResend({ to: recipients, subject, html, text, replyTo });
    for (const recipient of recipients) logMail({ recipient, subject, kind, status: 'sent' });
    log.info('e-post sendt', { to: recipients, subject, kind, id: result && result.id });
    return result;
  } catch (err) {
    for (const recipient of recipients) {
      logMail({ recipient, subject, kind, status: 'failed', error: err.message });
    }
    throw err;
  }
}
