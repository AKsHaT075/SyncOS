const AiUsageEvent = require('../../models/AiUsageEvent');
const { keys, withRedis } = require('./aiLimits.service');

/**
 * Durable usage recording. The model call has already happened (and been paid
 * for) by the time we get here, so a failed write must never fail the user's
 * request. Order of defence:
 *
 *   1. Upsert into MongoDB, keyed by requestKey (idempotent), retried briefly.
 *   2. If Mongo keeps failing, park the event in a Redis outbox list. A job
 *      (aiJobs) drains it back into Mongo later; the same requestKey makes a
 *      repeated drain harmless.
 *   3. If Redis is also down, log the non-sensitive fields so the loss is at
 *      least visible to operators. This is the one unrecoverable case.
 *
 * Events contain no prompts, completions or secrets (see AiUsageEvent).
 */

const WRITE_ATTEMPTS = 3;
const OUTBOX_MAX = 10000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const upsert = (doc) => AiUsageEvent.updateOne({ requestKey: doc.requestKey }, { $setOnInsert: doc }, { upsert: true });

/** @returns {'recorded' | 'outbox' | 'lost'} */
async function recordUsage(doc) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await upsert(doc);
      return 'recorded';
    } catch (error) {
      if (attempt === WRITE_ATTEMPTS - 1) console.error('[ai-usage] MongoDB write failed:', error.message);
      // eslint-disable-next-line no-await-in-loop
      else await sleep(40 * 2 ** attempt);
    }
  }

  try {
    await withRedis(async (client) => {
      await client.lPush(keys.outbox(), JSON.stringify(doc));
      await client.lTrim(keys.outbox(), 0, OUTBOX_MAX - 1);
    });
    return 'outbox';
  } catch {
    console.error('[ai-usage] LOST usage event (MongoDB and Redis unavailable):', {
      requestKey: doc.requestKey,
      organization: String(doc.organization),
      user: String(doc.user),
      feature: doc.feature,
      status: doc.status,
      errorCode: doc.errorCode,
      totalTokens: doc.totalTokens,
      chargedTokens: doc.chargedTokens,
    });
    return 'lost';
  }
}

/** Moves parked events into MongoDB. Stops (and re-parks the event) at the first failure. Returns how many were stored. */
async function drainUsageOutbox({ max = 200 } = {}) {
  let stored = 0;
  for (let i = 0; i < max; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await withRedis((client) => client.rPop(keys.outbox()));
    if (!raw) break;
    let doc;
    try {
      doc = JSON.parse(raw);
      doc.createdAt = new Date(doc.createdAt);
    } catch {
      continue; // unreadable entry: drop it rather than block the queue
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await upsert(doc);
      stored += 1;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await withRedis((client) => client.rPush(keys.outbox(), raw)).catch(() => {});
      break;
    }
  }
  return stored;
}

module.exports = { drainUsageOutbox, recordUsage };
