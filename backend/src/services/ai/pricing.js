const env = require('../../config/env');

/**
 * Price table, USD per 1M tokens. These are ESTIMATES for usage dashboards, not
 * billing. A model without a price yields `null` (never a guess), and the usage
 * layer records it as unpriced.
 *
 * Defaults mirror Groq's published list prices at the time of writing and WILL
 * drift: override or extend with AI_PRICING_JSON, e.g.
 *   AI_PRICING_JSON={"llama-3.3-70b-versatile":{"input":0.59,"output":0.79}}
 */
const DEFAULT_PRICES = Object.freeze({
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
});

function loadOverrides() {
  if (!env.AI_PRICING_JSON) return {};
  try {
    const parsed = JSON.parse(env.AI_PRICING_JSON);
    const clean = {};
    for (const [model, price] of Object.entries(parsed || {})) {
      if (price && Number.isFinite(price.input) && Number.isFinite(price.output) && price.input >= 0 && price.output >= 0) {
        clean[model] = { input: price.input, output: price.output };
      }
    }
    return clean;
  } catch {
    console.error('[ai] AI_PRICING_JSON is not valid JSON; ignoring it');
    return {};
  }
}

const PRICES = { ...DEFAULT_PRICES, ...loadOverrides() };

/** Short stable fingerprint of the active price table, stored on each usage event so old costs stay explainable. */
const PRICING_VERSION = require('crypto')
  .createHash('sha1')
  .update(JSON.stringify(Object.keys(PRICES).sort().map((model) => [model, PRICES[model].input, PRICES[model].output])))
  .digest('hex')
  .slice(0, 8);

function pricingVersion() {
  return PRICING_VERSION;
}

function priceFor(model) {
  return PRICES[model] || null;
}

/** Estimated cost in micro-USD (integer, 1e-6 USD), or null when the model is unpriced. */
function estimateCostMicros(model, inputTokens, outputTokens) {
  const price = priceFor(model);
  if (!price) return null;
  // USD per 1M tokens == micro-USD per token.
  return Math.round(inputTokens * price.input + outputTokens * price.output);
}

module.exports = { estimateCostMicros, priceFor, pricingVersion };
