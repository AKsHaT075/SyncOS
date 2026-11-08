const crypto = require('crypto');
const env = require('../config/env');
const { createRedisClient } = require('../config/redis');

/**
 * Reliable email queue on Redis.
 *
 *   <p>:queue       ready jobs (LIST)           — the legacy key, so jobs
 *                    queued by the previous version are still processed
 *   <p>:processing  claimed jobs (ZSET, score = claim time)
 *   <p>:delayed     retries waiting for their backoff (ZSET, score = run-at)
 *   <p>:dead        jobs that exhausted their retries (LIST, newest first)
 *   <p>:done:<id>   marker that a jobId was already delivered (dedupe)
 *   <p>:lock:<id>   short lock while a jobId is being sent
 *
 * Guarantees (at-least-once, with dedupe for identified jobs):
 *  - A job is moved ready→processing atomically (Lua), so a worker crash can
 *    never lose it; stale `processing` entries are recovered on restart.
 *  - Failures wait in `delayed` instead of sleeping inside the worker, so one
 *    bad address never blocks other mail.
 *  - Jobs with a `jobId` are sent at most once: a `done` marker plus a send
 *    lock absorb duplicates (re-enqueues, sweeper overlap, two workers).
 *  - Exhausted jobs go to the dead-letter list instead of vanishing.
 *
 * Callers that don't pass a jobId (OTP, reset, invitations) behave exactly as
 * before from the caller's side.
 */

const PREFIX = env.EMAIL_QUEUE_PREFIX;
const KEYS = Object.freeze({
  ready: `${PREFIX}:queue`,
  processing: `${PREFIX}:processing`,
  delayed: `${PREFIX}:delayed`,
  dead: `${PREFIX}:dead`,
  done: (id) => `${PREFIX}:done:${id}`,
  lock: (id) => `${PREFIX}:lock:${id}`,
});

const MAX_RETRIES = 3; // 1 initial attempt + 3 retries, as before
const BACKOFF_MS = [5 * 1000, 30 * 1000, 2 * 60 * 1000];
const STALE_CLAIM_MS = 5 * 60 * 1000;
const DONE_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 120;
const DEAD_LETTER_LIMIT = 1000;
const MAX_RECOVERY_ATTEMPTS = MAX_RETRIES + 1; // a job that keeps crashing the worker stops here

const CLAIM_SCRIPT = `
local job = redis.call('LPOP', KEYS[1])
if job then redis.call('ZADD', KEYS[2], ARGV[1], job) end
return job
`;

const PROMOTE_SCRIPT = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, job in ipairs(due) do
  if redis.call('ZREM', KEYS[1], job) == 1 then redis.call('RPUSH', KEYS[2], job) end
end
return #due
`;

const resultHooks = [];
/** fn({ job, status: 'sent' | 'retrying' | 'failed', error }) — used to mirror delivery state onto notifications. */
function onJobResult(fn) {
  resultHooks.push(fn);
}

async function emit(event) {
  for (const hook of resultHooks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await hook(event);
    } catch (error) {
      console.error('[email-queue] result hook failed:', error.message);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Queues an email. Returns true when the job is safely in Redis (or was
 * already delivered), false when Redis was unavailable — never throws, so a
 * mail problem can't fail the caller's business operation.
 */
async function enqueueEmail({ to, subject, text, html, jobId = null, meta = null }) {
  try {
    const client = createRedisClient();
    if (jobId && (await client.exists(KEYS.done(jobId)))) {
      return true; // already delivered
    }
    const job = { queueId: crypto.randomUUID(), to, subject, text, html, attempts: 0 };
    if (jobId) job.jobId = jobId;
    if (meta) job.meta = meta;
    await client.rPush(KEYS.ready, JSON.stringify(job));
    return true;
  } catch (error) {
    console.error('[email-queue] Failed to enqueue email:', error.message);
    return false;
  }
}

async function claimJob(client, now) {
  return client.eval(CLAIM_SCRIPT, { keys: [KEYS.ready, KEYS.processing], arguments: [String(now)] });
}

async function promoteDelayed(client, now) {
  return client.eval(PROMOTE_SCRIPT, { keys: [KEYS.delayed, KEYS.ready], arguments: [String(now)] });
}

async function deadLetter(client, job, error) {
  const entry = { ...job, error: String(error || 'unknown'), failedAt: new Date().toISOString() };
  await client.lPush(KEYS.dead, JSON.stringify(entry));
  await client.lTrim(KEYS.dead, 0, DEAD_LETTER_LIMIT - 1);
}

/**
 * Re-queues jobs claimed by a worker that died (or hung) mid-send. Each
 * recovery counts as an attempt, so a job that crashes workers repeatedly
 * ends up dead-lettered rather than looping forever.
 */
async function recoverStale(client, now) {
  const stale = await client.zRangeByScore(KEYS.processing, '-inf', now - STALE_CLAIM_MS, {
    LIMIT: { offset: 0, count: 50 },
  });
  let recovered = 0;
  for (const raw of stale) {
    // ZREM returns 1 for exactly one claimant, so two workers can't both recover it.
    // eslint-disable-next-line no-await-in-loop
    if ((await client.zRem(KEYS.processing, raw)) !== 1) continue;
    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await deadLetter(client, { raw }, 'unparseable stale job');
      continue;
    }
    job.attempts = (job.attempts || 0) + 1;
    if (job.attempts >= MAX_RECOVERY_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await deadLetter(client, job, 'worker crashed repeatedly while sending');
      // eslint-disable-next-line no-await-in-loop
      await emit({ job, status: 'failed', error: 'worker crashed repeatedly while sending' });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await client.rPush(KEYS.ready, JSON.stringify(job));
      recovered += 1;
    }
  }
  return recovered;
}

/**
 * One scheduler tick: promote due retries, claim one job, deliver it.
 * Returns true when a job was handled (so the loop can skip its idle sleep).
 */
async function processOnce({ now = Date.now(), recover = false } = {}) {
  const client = createRedisClient();
  const { sendEmail } = require('./email.service');

  await promoteDelayed(client, now);
  if (recover) await recoverStale(client, now);

  const raw = await claimJob(client, now);
  if (!raw) return false;

  const ack = () => client.zRem(KEYS.processing, raw);

  let job;
  try {
    job = JSON.parse(raw);
  } catch {
    await deadLetter(client, { raw }, 'unparseable job');
    await ack();
    return true;
  }

  const { jobId } = job;
  let locked = false;
  let sendError = null;
  let skipped = false;

  try {
    if (jobId) {
      if (await client.exists(KEYS.done(jobId))) {
        skipped = true; // duplicate of an already-delivered job
      } else {
        locked = Boolean(await client.set(KEYS.lock(jobId), '1', { NX: true, EX: LOCK_TTL_SECONDS }));
        skipped = !locked; // another worker is sending this very job
      }
    }
    if (!skipped) {
      await sendEmail({ to: job.to, subject: job.subject, text: job.text, html: job.html });
    }
  } catch (error) {
    sendError = error;
  }

  try {
    if (skipped) {
      await ack();
    } else if (!sendError) {
      // Sent. Mark done first: if the ack below fails, a recovered duplicate is dropped by jobId.
      if (jobId) await client.set(KEYS.done(jobId), '1', { EX: DONE_TTL_SECONDS });
      await ack();
      await emit({ job, status: 'sent' });
    } else {
      const attempts = (job.attempts || 0) + 1;
      if (attempts <= MAX_RETRIES) {
        const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
        // Schedule the retry BEFORE acking: a crash in between duplicates the
        // job (deduped by jobId) instead of losing it.
        await client.zAdd(KEYS.delayed, {
          score: now + delay,
          value: JSON.stringify({ ...job, attempts, lastError: sendError.message, queueId: crypto.randomUUID() }),
        });
        await ack();
        await emit({ job, status: 'retrying', error: sendError.message });
      } else {
        await deadLetter(client, { ...job, attempts }, sendError.message);
        await ack();
        await emit({ job: { ...job, attempts }, status: 'failed', error: sendError.message });
      }
    }
  } catch (bookkeepingError) {
    // Leave the job in `processing`; recoverStale will pick it up.
    console.error('[email-queue] failed to record a job result:', bookkeepingError.message);
  } finally {
    if (locked) await client.del(KEYS.lock(jobId)).catch(() => {});
  }

  return true;
}

let stopRequested = false;

async function processEmailQueue({ pollMs = 1000 } = {}) {
  stopRequested = false;
  let lastRecovery = 0; // recover immediately on start (worker restart), then every 30s

  while (!stopRequested) {
    try {
      const now = Date.now();
      const recover = now - lastRecovery > 30 * 1000;
      if (recover) lastRecovery = now;
      // eslint-disable-next-line no-await-in-loop
      const handled = await processOnce({ now, recover });
      // eslint-disable-next-line no-await-in-loop
      if (!handled) await sleep(pollMs);
    } catch (error) {
      console.error('[email-queue] Queue processing error:', error.message);
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
  }
}

function stopEmailWorker() {
  stopRequested = true;
}

async function getQueueStats() {
  const client = createRedisClient();
  const [ready, processing, delayed, dead] = await Promise.all([
    client.lLen(KEYS.ready),
    client.zCard(KEYS.processing),
    client.zCard(KEYS.delayed),
    client.lLen(KEYS.dead),
  ]);
  return { ready, processing, delayed, dead };
}

module.exports = {
  KEYS,
  MAX_RETRIES,
  enqueueEmail,
  getQueueStats,
  onJobResult,
  processEmailQueue,
  processOnce,
  recoverStale,
  stopEmailWorker,
};
