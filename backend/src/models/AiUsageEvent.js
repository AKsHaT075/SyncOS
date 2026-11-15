const mongoose = require('mongoose');
const env = require('../config/env');
const { AI_FEATURES, AI_USAGE_STATUS } = require('../constants/ai.constants');

/**
 * One row per AI request (including requests refused by a quota). This is the
 * durable usage record behind dashboards and quota reconciliation.
 *
 * DELIBERATELY ABSENT: prompts, completions, tool arguments/results, document
 * text, titles, names and the API key. The schema is strict, so a stray field
 * is dropped rather than stored. Conversation content lives only in the
 * member's own conversation.
 */
const aiUsageEventSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    feature: { type: String, enum: Object.values(AI_FEATURES), required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, default: null }, // reference only; no title or content

    // One logical request == one key, however many provider attempts it took. Makes persistence idempotent.
    requestKey: { type: String, required: true },
    providerRequestId: { type: String, default: null },

    provider: { type: String, required: true },
    model: { type: String, required: true },

    status: { type: String, enum: Object.values(AI_USAGE_STATUS), required: true },
    errorCode: { type: String, default: null }, // normalized category (e.g. AI_PROVIDER_TIMEOUT), never a message
    streamStarted: { type: Boolean, default: false },

    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    tokensEstimated: { type: Boolean, default: false }, // true when the provider reported no usage

    reservedTokens: { type: Number, default: 0 }, // what the quota held while the request ran
    chargedTokens: { type: Number, default: 0 }, // what the quota finally kept
    quotaSettled: { type: Boolean, default: true }, // false: the quota store failed at settlement; the reservation stays counted

    // Live-data tool use of this request: counts and time only, never what was looked up.
    toolCalls: { type: Number, default: 0 },
    toolMs: { type: Number, default: 0 },
    toolFailures: { type: Number, default: 0 },

    estimatedCostMicros: { type: Number, default: null }, // micro-USD; null = model has no price
    pricingVersion: { type: String, default: null },

    latencyMs: { type: Number, default: 0 },
    firstEventMs: { type: Number, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  { strict: true, versionKey: false },
);

aiUsageEventSchema.index({ requestKey: 1 }, { unique: true });
aiUsageEventSchema.index({ organization: 1, createdAt: -1 });
aiUsageEventSchema.index({ organization: 1, user: 1, createdAt: -1 });
aiUsageEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: env.AI_USAGE_RETENTION_DAYS * 86400 });

module.exports = mongoose.model('AiUsageEvent', aiUsageEventSchema);
