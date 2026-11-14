const mongoose = require('mongoose');
const request = require('supertest');
const DocumentChunk = require('../../src/models/DocumentChunk');
const tokens = require('../../src/services/ai/aiService/tokens');
const { make } = require('../../src/services/ai/aiService/errors');
const { createFakeProvider } = require('./fakeAiProvider');

/**
 * A stand-in for the Python AI service for tests that exercise Node: it authorizes through Node's REAL internal endpoint with the
 * REAL per-request callback token, then "answers" from what it was given. `seen` records exactly what Node asked of it.
 */
function createRagEngine(internalApp) {
  const fake = createFakeProvider();
  const engine = {
    ...fake,
    seen: [],
    plan: { noContext: false, failBeforeText: false, failAfterText: false, hang: false },
    async status() {
      return { reachable: true, configured: true, provider: 'groq', models: { chat: 'openai/gpt-oss-120b', summarize: 'openai/gpt-oss-120b' }, version: 'test', replayStore: 'memory' };
    },
    async* chat(params) {
      engine.seen.push(params);
      if (!params.rag) return yield* fake.chat(params);
      if (engine.plan.failBeforeText) throw make('AI_RETRIEVAL_UNAVAILABLE');
      const { identity } = params;
      const callback = tokens.signCallbackToken({ ...identity, scopes: [tokens.CALLBACK_SCOPES.KNOWLEDGE_AUTHORIZE] });
      const chunks = await DocumentChunk.find({ organization: identity.orgId, pipelineVersion: 'p2' }).sort({ document: 1, chunkIndex: 1 }).lean();
      const res = chunks.length === 0
        ? { status: 200, body: { items: [], rejected: 0 } }
        : await request(internalApp).post('/internal/ai/knowledge/authorize').set('Authorization', `Bearer ${callback}`).send({ candidates: chunks.slice(0, 50).map((c) => ({ documentId: c.document.toString(), version: c.version, chunkIndex: c.chunkIndex, textHash: c.textHash })) });
      const items = res.body.items;
      yield { type: 'retrieval', candidates: chunks.length, authorized: items.length, rejected: res.body.rejected, belowThreshold: 0, duplicates: 0, used: items.length, rounds: 1, topScore: 0.9 };
      if (engine.plan.noContext || items.length === 0) {
        yield { type: 'text', text: 'I could not find information about this in the documents you have access to.' };
        yield { type: 'usage', inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false };
        yield { type: 'citations', citations: [], unverifiedMarkers: [], consideredSources: 0, uncited: true };
        yield { type: 'done', finishReason: 'no_context', model: null, provider: 'groq', requestId: null, firstEventMs: 0 };
        return;
      }
      yield { type: 'text', text: `Answer to "${params.rag.question}" from ${items.map((_, i) => `[${i + 1}]`).join('')}` };
      if (engine.plan.failAfterText) throw make('AI_SERVICE_UNAVAILABLE', { streamStarted: true });
      if (engine.plan.hang) await new Promise((resolve) => params.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'usage', inputTokens: 900, outputTokens: 40, totalTokens: 940, estimated: false };
      const citations = items.map((it, i) => ({ n: i + 1, chunkId: it.chunkId, documentId: it.documentId, documentName: it.documentName, version: it.version, chunkIndex: it.chunkIndex, location: it.location, score: 0.9 }));
      yield { type: 'citations', citations, unverifiedMarkers: [], consideredSources: items.length, uncited: false };
      yield { type: 'done', finishReason: 'stop', model: 'openai/gpt-oss-120b', provider: 'groq', requestId: 'r', firstEventMs: 3 };
    },
  };
  engine.resetPlan = () => { engine.plan = { noContext: false, failBeforeText: false, failAfterText: false, hang: false }; engine.seen.length = 0; };
  return engine;
}

module.exports = { createRagEngine, mongoose };
