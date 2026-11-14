const env = require('../../config/env');
const { createRedisClient } = require('../../config/redis');
const { drainUsageOutbox } = require('./aiUsageRecorder.service');
const { recoverStale } = require('./ingestion/ingestionJobs.service');
const { sweepAll } = require('./ingestion/ingestionReconcile.service');
const embeddingJobs = require('./embedding/embeddingJobs.service');
const embeddingReconcile = require('./embedding/embeddingReconcile.service');
const conversationRetention = require('./conversations/conversationRetention.service');

const TICK_MS = 60 * 1000;
const SWEEP_EVERY_TICKS = 10; // reconciliation is heavier: roughly every 10 minutes

async function withLock(name, ttlSeconds, fn) {
  const client = createRedisClient();
  if (!client.isOpen) return null; // no Redis: nothing parked there, and nothing to coordinate
  const acquired = await client.set(`${env.AI_REDIS_PREFIX}:lock:${name}`, '1', { NX: true, EX: ttlSeconds });
  return acquired ? fn() : null; // another instance has this tick
}

/** Moves usage events that could not reach MongoDB at request time into it (idempotent). */
async function runAiJobs() {
  const stored = await drainUsageOutbox();
  // Ingestion jobs whose worker vanished (lease expired) become failed/dead. MongoDB conditional updates make this
  // safe even if two instances run it; the Redis lock just avoids the duplicated work.
  const stale = await recoverStale();
  const embeddingStale = await embeddingJobs.recoverStale();
  const conversationsRecovered = await conversationRetention.recoverStale();
  const conversationsPurged = await conversationRetention.purgeExpired();
  return { usageEventsRecovered: stored, ingestionStale: stale, embeddingStale, conversationsRecovered, conversationsPurged };
}

/** Back-fills documents of AI-enabled organizations, repairs drift, drops chunks of trashed documents. */
async function runIngestionSweep() {
  const ingestion = await sweepAll();
  const embedding = await embeddingReconcile.sweepAll();
  return { ingestion, embedding };
}

function startAiJobs() {
  let ticks = 0;
  const tick = () => {
    withLock('jobs', 50, runAiJobs).catch((error) => console.error('[ai] jobs failed:', error.name));
    ticks += 1;
    if (ticks % SWEEP_EVERY_TICKS === 1) {
      withLock('ingest-sweep', 540, runIngestionSweep).catch((error) => console.error('[ai] ingestion sweep failed:', error.name));
    }
  };
  tick();
  const interval = setInterval(tick, TICK_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

module.exports = { runAiJobs, runIngestionSweep, startAiJobs };
