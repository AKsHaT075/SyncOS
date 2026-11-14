const { make } = require('../../src/services/ai/aiService/errors');
const { AI_ERROR_CODES: C } = require('../../src/constants/ai.constants');
const aiService = require('../../src/services/ai/aiService');

/**
 * A scriptable stand-in for the AI-service engine: same `chat()` event contract
 * (text / tool_calls / usage / done), no network, no key. Install it with
 * aiService.setEngine(fake). `setConfigured(false)` simulates an unconfigured / unreachable service.
 *
 * Per-call plans (queued with enqueue(), else the default plan):
 *   text        string | string[]      content chunks to stream
 *   usage       {in, out} | null       null => the provider reports no usage at all
 *   failBefore  error code             throw before any output
 *   failAfter   error code             throw after the text has streamed
 *   hang        true                   after the text, wait until the caller aborts
 *   gate        true                   wait (before anything) for fake.openGate()
 *   delayMs     number
 *   model       string                 model reported in `done`
 */
function createFakeProvider() {
  const queue = [];
  let defaultPlan = { text: 'COMPLETION-SECRET answer', usage: { in: 20, out: 10 } };
  let gate = null;
  let configured = true;
  const calls = [];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const whenAborted = (signal) =>
    new Promise((resolve) => {
      if (!signal) return;
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, { once: true });
    });
  const abortIfNeeded = (signal) => {
    if (signal?.aborted) throw make(C.ABORTED);
  };

  const fake = {
    name: 'fake',
    calls,
    async status() {
      return { reachable: configured, configured, provider: 'groq', models: { chat: 'openai/gpt-oss-120b', summarize: 'openai/gpt-oss-120b' }, version: 'test', replayStore: 'memory' };
    },
    setConfigured(value) {
      configured = value;
      aiService.invalidateStatus();
      return fake;
    },
    enqueue(plan) {
      queue.push(plan);
      return fake;
    },
    setDefault(plan) {
      defaultPlan = plan;
      return fake;
    },
    reset() {
      queue.length = 0;
      calls.length = 0;
      gate = null;
      configured = true;
      aiService.invalidateStatus();
      defaultPlan = { text: 'COMPLETION-SECRET answer', usage: { in: 20, out: 10 } };
    },
    closeGate() {
      let open;
      const promise = new Promise((resolve) => {
        open = resolve;
      });
      gate = { promise, open };
    },
    openGate() {
      gate?.open();
    },
    async* chat(params) {
      calls.push(params);
      const plan = queue.shift() || defaultPlan;
      abortIfNeeded(params.signal);

      if (plan.gate && gate) await Promise.race([gate.promise, whenAborted(params.signal)]);
      abortIfNeeded(params.signal);
      if (plan.delayMs) await sleep(plan.delayMs);
      abortIfNeeded(params.signal);
      if (plan.failBefore) throw make(plan.failBefore);

      const chunks = plan.text === undefined ? [] : Array.isArray(plan.text) ? plan.text : [plan.text];
      for (const chunk of chunks) {
        abortIfNeeded(params.signal);
        yield { type: 'text', text: chunk };
      }
      if (plan.hang) {
        await whenAborted(params.signal);
        throw make(C.ABORTED);
      }
      if (plan.failAfter) throw make(plan.failAfter, { streamStarted: true });

      if (plan.usage) {
        yield { type: 'usage', inputTokens: plan.usage.in, outputTokens: plan.usage.out, totalTokens: plan.usage.in + plan.usage.out, estimated: false };
      }
      yield { type: 'done', finishReason: 'stop', model: plan.model || 'openai/gpt-oss-120b', requestId: 'fake_req', firstEventMs: 1 };
    },
  };
  return fake;
}

module.exports = { createFakeProvider };
