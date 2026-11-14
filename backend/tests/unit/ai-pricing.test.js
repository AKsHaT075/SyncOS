const { estimateCostMicros, priceFor } = require('../../src/services/ai/pricing');

afterEach(() => {
  process.env.AI_PRICING_JSON = '';
});

describe('cost estimation (stays in Node: Python reports tokens and model only)', () => {
  test('prices known models in micro-USD', () => {
    expect(estimateCostMicros('openai/gpt-oss-120b', 1000, 500)).toBe(450);
    expect(estimateCostMicros('openai/gpt-oss-20b', 1000000, 1000000)).toBe(375000);
  });

  test('cost is null (not a guess) for an unpriced model', () => {
    expect(estimateCostMicros('some/unknown-model', 1000, 1000)).toBeNull();
    expect(priceFor('some/unknown-model')).toBeNull();
  });

  // Prices are read once at startup, so each case loads a fresh copy of the module with the env already set.
  const load = (json) => {
    process.env.AI_PRICING_JSON = json; // isolateModules re-evaluates config/env, which reads process.env
    let mod;
    jest.isolateModules(() => {
      mod = require('../../src/services/ai/pricing');
    });
    return mod;
  };

  test('AI_PRICING_JSON overrides and extends prices; invalid entries and invalid JSON are ignored', () => {
    const custom = load(JSON.stringify({ 'x/model': { input: 1, output: 2 }, 'bad/model': { input: -1, output: 1 } }));
    expect(custom.estimateCostMicros('x/model', 1000000, 1000000)).toBe(3000000);
    expect(custom.estimateCostMicros('bad/model', 1, 1)).toBeNull();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(load('{not json').estimateCostMicros('openai/gpt-oss-120b', 1000, 500)).toBe(450);
    console.error.mockRestore();
  });

  test('the pricing version changes when prices change', () => {
    const before = load('').pricingVersion();
    const after = load(JSON.stringify({ 'openai/gpt-oss-120b': { input: 9, output: 9 } })).pricingVersion();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{8}$/);
  });
});
