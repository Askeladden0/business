import { existsSync, readFileSync } from 'node:fs';

// Minimal .env loader. Avoids a dependency; only used outside production,
// where secrets come from the platform's secret store instead.
function loadDotenv(path = '.env') {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv(process.env.DOTENV_PATH || '.env');

const env = process.env;
const nodeEnv = env.NODE_ENV || 'development';

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} må være et heltall, fikk "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',

  port: int('PORT', 8080),
  baseUrl: (env.BASE_URL || `http://localhost:${int('PORT', 8080)}`).replace(/\/+$/, ''),

  brand: {
    name: env.BRAND_NAME || 'Registervakt',
    tagline: env.BRAND_TAGLINE || 'Vet før kunden din går konkurs',
    supportEmail: env.SUPPORT_EMAIL || 'hei@example.no',
    orgName: env.ORG_NAME || 'Registervakt',
    orgNumber: env.ORG_NUMBER || '',
  },

  databasePath: env.DATABASE_PATH || (nodeEnv === 'test' ? ':memory:' : './data/registervakt.db'),
  backupDir: env.BACKUP_DIR || './data/backups',

  brreg: {
    baseUrl: (env.BRREG_BASE_URL || 'https://data.brreg.no/enhetsregisteret/api').replace(/\/+$/, ''),
    // Brreg produserer nye data nattlig, så hyppigere enn hver time er bortkastet.
    pollIntervalMinutes: int('POLL_INTERVAL_MINUTES', 60),
    pageSize: int('BRREG_PAGE_SIZE', 1000),
    maxPagesPerRun: int('BRREG_MAX_PAGES_PER_RUN', 60),
    concurrency: int('BRREG_CONCURRENCY', 4),
    timeoutMs: int('BRREG_TIMEOUT_MS', 20000),
    userAgent: env.BRREG_USER_AGENT || 'Registervakt/1.0 (+https://github.com/Askeladden0/business)',
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    prices: {
      solo: env.STRIPE_PRICE_SOLO || '',
      byraa: env.STRIPE_PRICE_BYRAA || '',
    },
    trialDays: int('STRIPE_TRIAL_DAYS', 14),
  },

  mail: {
    provider: env.MAIL_PROVIDER || (nodeEnv === 'production' ? 'resend' : 'console'),
    resendApiKey: env.RESEND_API_KEY || '',
    from: env.MAIL_FROM || 'Registervakt <varsel@example.no>',
    replyTo: env.MAIL_REPLY_TO || '',
    timeoutMs: int('MAIL_TIMEOUT_MS', 15000),
  },

  ops: {
    alertEmail: env.ALERT_EMAIL || '',
    // Hvor lenge en feilsignatur er stille etter første varsel.
    alertCooldownMinutes: int('ALERT_COOLDOWN_MINUTES', 120),
    // Varsle hvis pollejobben ikke har lykkes på dette antallet timer.
    stalePollHours: int('STALE_POLL_HOURS', 6),
    adminToken: env.ADMIN_TOKEN || '',
  },

  digestHourOslo: int('DIGEST_HOUR_OSLO', 7),
  sessionDays: int('SESSION_DAYS', 30),
  magicLinkMinutes: int('MAGIC_LINK_MINUTES', 30),
  schedulerEnabled: bool('SCHEDULER_ENABLED', nodeEnv !== 'test'),
  trustProxy: bool('TRUST_PROXY', nodeEnv === 'production'),
};

/**
 * Kaster hvis noe som må være satt i produksjon mangler. Kalles fra
 * src/index.js ved oppstart, slik at feilkonfigurasjon oppdages ved deploy
 * og ikke først når en kunde prøver å betale.
 */
export function assertProductionConfig(cfg = config) {
  if (!cfg.isProduction) return [];
  const missing = [];
  const require = (value, name) => {
    if (!value) missing.push(name);
  };
  require(cfg.stripe.secretKey, 'STRIPE_SECRET_KEY');
  require(cfg.stripe.webhookSecret, 'STRIPE_WEBHOOK_SECRET');
  require(cfg.stripe.prices.solo, 'STRIPE_PRICE_SOLO');
  require(cfg.stripe.prices.byraa, 'STRIPE_PRICE_BYRAA');
  require(cfg.mail.resendApiKey, 'RESEND_API_KEY');
  require(cfg.ops.alertEmail, 'ALERT_EMAIL');
  require(cfg.ops.adminToken, 'ADMIN_TOKEN');
  if (!cfg.baseUrl.startsWith('https://')) missing.push('BASE_URL (må være https)');
  if (missing.length) {
    throw new Error(
      `Manglende produksjonskonfigurasjon: ${missing.join(', ')}. ` +
        'Se .env.example og HANDOVER.md.',
    );
  }
  return missing;
}
