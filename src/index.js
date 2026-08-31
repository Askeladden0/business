import { config, assertProductionConfig } from './config.js';
import { log } from './log.js';
import { getDb, closeDb } from './db.js';
import { createAppServer } from './server.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { opsAlert } from './alerts.js';

assertProductionConfig();
getDb();

const server = createAppServer();

server.listen(config.port, '0.0.0.0', () => {
  log.info('registervakt kjører', {
    port: config.port,
    baseUrl: config.baseUrl,
    miljø: config.nodeEnv,
    epostleverandør: config.mail.provider,
    betalingKonfigurert: Boolean(config.stripe.secretKey),
  });
});

startScheduler();

// En uventet feil skal aldri drepe tjenesten i stillhet. Vi varsler eieren og
// lar prosessen leve videre; Fly starter den uansett på nytt hvis den dør.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { err });
  opsAlert('uncaughtException', 'Uventet feil i prosessen', `${err.message}\n\n${err.stack || ''}`)
    .catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error('unhandledRejection', { err });
  opsAlert('unhandledRejection', 'Ubehandlet avvisning', `${err.message}\n\n${err.stack || ''}`)
    .catch(() => {});
});

function shutdown(signal) {
  log.info('avslutter', { signal });
  stopScheduler();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Ikke heng for alltid på åpne forbindelser.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
