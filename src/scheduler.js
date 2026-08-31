import { config } from './config.js';
import { log } from './log.js';
import { lastSuccessfulRun } from './db.js';
import {
  runJob, pollBrreg, sendDailyDigest, healthWatchdog, cleanup, backupDatabase,
  weeklyBackupEmail, osloNow, parseDbTime,
} from './jobs.js';

const TICK_MS = 60_000;

function minutesSinceLastSuccess(job) {
  const last = lastSuccessfulRun(job);
  if (!last) return Number.POSITIVE_INFINITY;
  const ms = parseDbTime(last.started_at);
  if (ms === null) return Number.POSITIVE_INFINITY;
  return (Date.now() - ms) / 60_000;
}

function ranTodayOslo(job, now) {
  const last = lastSuccessfulRun(job);
  if (!last) return false;
  const ms = parseDbTime(last.started_at);
  if (ms === null) return false;
  return osloNow(new Date(ms)).date === now.date;
}

/**
 * Jobbdefinisjoner. `due` leser siste vellykkede kjøring fra databasen i
 * stedet for å holde tid i minnet, slik at en omstart verken dobbeltkjører
 * eller hopper over noe.
 */
const JOBS = [
  {
    name: 'poll',
    run: pollBrreg,
    due: () => minutesSinceLastSuccess('poll') >= config.brreg.pollIntervalMinutes,
  },
  {
    name: 'digest',
    run: sendDailyDigest,
    due: (now) => now.hour === config.digestHourOslo && !ranTodayOslo('digest', now),
  },
  {
    name: 'watchdog',
    run: healthWatchdog,
    due: () => minutesSinceLastSuccess('watchdog') >= 15,
  },
  {
    name: 'cleanup',
    run: cleanup,
    due: (now) => now.hour === 3 && !ranTodayOslo('cleanup', now),
  },
  {
    name: 'backup',
    run: backupDatabase,
    due: (now) => now.hour === 2 && !ranTodayOslo('backup', now),
  },
  {
    name: 'backup-epost',
    run: weeklyBackupEmail,
    // Mandag klokken 06 norsk tid.
    due: (now) => {
      if (now.hour !== 6) return false;
      const weekday = new Date(`${now.date}T12:00:00Z`).getUTCDay();
      if (weekday !== 1) return false;
      return minutesSinceLastSuccess('backup-epost') >= 60 * 24;
    },
  },
];

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const now = osloNow();
    for (const job of JOBS) {
      let due = false;
      try {
        due = job.due(now);
      } catch (err) {
        log.error('kunne ikke avgjøre om jobb skulle kjøre', { job: job.name, err });
      }
      if (due) await runJob(job.name, job.run);
    }
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (!config.schedulerEnabled) {
    log.info('planleggeren er avslått');
    return () => {};
  }
  log.info('starter planleggeren', {
    pollIntervallMinutter: config.brreg.pollIntervalMinutes,
    daglig: `${config.digestHourOslo}:00 Europe/Oslo`,
  });
  // Første tikk med litt forsinkelse, slik at serveren rekker å svare på
  // helsesjekk før den begynner å hente data.
  timer = setTimeout(function loop() {
    tick().finally(() => {
      timer = setTimeout(loop, TICK_MS);
    });
  }, 5_000);
  if (timer.unref) timer.unref();
  return stopScheduler;
}

export function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export { JOBS, tick as runSchedulerTick };
