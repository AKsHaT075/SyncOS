const asyncHandler = require('../utils/async-handler');
const { AI_LIVE_TOOL_NAMES } = require('../constants/ai.constants');
const settings = require('../services/ai/aiSettings.service');
const usage = require('../services/ai/aiUsage.service');
const ingestion = require('../services/ai/ingestion/ingestionAdmin.service');
const embedding = require('../services/ai/embedding/embeddingAdmin.service');
const { streamAnswer, answerQuestion } = require('../services/ai/rag/ask.service');
const conversations = require('../services/ai/conversations/conversation.service');
const chat = require('../services/ai/conversations/conversationChat.service');

const ok = (res, payload) => res.json({ success: true, ...payload });

const status = asyncHandler(async (req, res) => ok(res, { status: await settings.getStatus({ actor: req.user }) }));
const disclosure = asyncHandler(async (req, res) => ok(res, { disclosure: settings.getDisclosure(), liveDataDisclosure: settings.getLiveDataDisclosure() }));
const getSettings = asyncHandler(async (req, res) => ok(res, await settings.getSettings({ actor: req.user })));
const updateSettings = asyncHandler(async (req, res) => ok(res, await settings.updateSettings({ actor: req.user, body: req.body, req })));
const platformControlService = require('../services/ai/aiPlatformControl.service');
const platformControl = asyncHandler(async (req, res) => ok(res, { control: await platformControlService.getControl() }));
const updatePlatformControl = asyncHandler(async (req, res) => ok(res, { control: await platformControlService.updateControl({ actor: req.user, changes: req.body, req }) }));
const platformStatus = asyncHandler(async (req, res) => ok(res, { platform: await settings.getPlatformStatus() }));

const myUsage = asyncHandler(async (req, res) => ok(res, { usage: await usage.getMyUsage({ actor: req.user, query: req.query }) }));
const orgUsage = asyncHandler(async (req, res) => ok(res, { usage: await usage.getOrgUsage({ actor: req.user, query: req.query }) }));
const platformUsage = asyncHandler(async (req, res) => ok(res, { usage: await usage.getPlatformUsage({ query: req.query }) }));

const ingestionOverview = asyncHandler(async (req, res) => ok(res, { ingestion: await ingestion.getOverview({ actor: req.user }) }));
const ingestionJobs = asyncHandler(async (req, res) => ok(res, await ingestion.listJobs({ actor: req.user, query: req.query })));
const ingestionRetry = asyncHandler(async (req, res) => ok(res, await ingestion.retryJob({ actor: req.user, id: req.params.id, req })));
const ingestionReconcile = asyncHandler(async (req, res) => ok(res, { result: await ingestion.reconcileNow({ actor: req.user, req }) }));

/** What the USER sees of retrieval: how many sources were used - never how many candidates were refused (that would hint at documents they cannot see). */
const forUser = (event) => {
  if (event.type === 'retrieval') return { type: 'retrieval', sourcesUsed: event.used };
  if (event.type === 'citations') return { type: 'citations', citations: event.citations, uncited: event.uncited, unverifiedMarkers: event.unverifiedMarkers };
  if (event.type === 'done') return { type: 'done', finishReason: event.finishReason, ...(event.messageId ? { messageId: event.messageId } : {}) };
  // The only other events that may reach a browser, rebuilt field by field (nothing is passed through by reference). ANYTHING ELSE
  // (a raw tool_calls event, a future internal event) is dropped: an unknown event must never be a way to leak internals.
  if (event.type === 'text') return { type: 'text', text: event.text };
  if (event.type === 'usage') return { type: 'usage', inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens, estimated: event.estimated };
  // Progress only: the NAME of a fixed tool, rebuilt as exactly {type, tool}. Never an argument, id, result or any other Python field.
  if (event.type === 'tool_activity') return AI_LIVE_TOOL_NAMES.includes(event.tool) ? { type: 'tool_activity', tool: event.tool } : null;
  if (event.type === 'meta') return { type: 'meta', conversationId: event.conversationId, userMessageId: event.userMessageId, assistantMessageId: event.assistantMessageId };
  return null;
};
const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** Runs `start(signal)` (an async iterable of events) and answers either as one JSON document or as SSE. Failures before the first event are ordinary HTTP errors. */
async function streamToResponse(req, res, { start, collect }) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(); // the browser went away: stop retrieval and generation, settle the quota, save what exists
  });
  const wantsStream = String(req.headers.accept || '').includes('text/event-stream') || req.query.stream === '1';
  if (!wantsStream) return res.json({ success: true, ...(await collect(controller.signal)) });

  const iterator = start(controller.signal)[Symbol.asyncIterator]();
  const first = await iterator.next(); // anything that fails BEFORE the first event (gate, limits, quota) is an ordinary HTTP error
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  try {
    let step = first;
    while (!step.done) {
      if (res.writableEnded || res.destroyed) break;
      const outgoing = forUser(step.value);
      if (outgoing) res.write(sse(outgoing));
      // eslint-disable-next-line no-await-in-loop
      step = await iterator.next();
    }
  } catch (error) {
    if (!res.destroyed) res.write(sse({ type: 'error', code: error.code || 'AI_INTERNAL_ERROR', message: error.statusCode && error.statusCode < 500 ? error.message : 'The request could not be completed' }));
  } finally {
    await iterator.return?.();
    if (!res.writableEnded) res.end();
  }
  return undefined;
}

const ask = asyncHandler((req, res) =>
  streamToResponse(req, res, {
    start: (signal) => streamAnswer({ actor: req.user, question: req.body.question, signal }),
    collect: async (signal) => {
      const { retrieval, ...rest } = await answerQuestion({ actor: req.user, question: req.body.question, signal });
      return { ...rest, retrieval: retrieval ? { sourcesUsed: retrieval.used } : null };
    },
  }),
);

// ---- Conversations (Phase 6): private to their owner; every call is scoped by the session's organization and user ----
const createConversation = asyncHandler(async (req, res) => res.status(201).json({ success: true, conversation: await conversations.createConversation({ actor: req.user, title: req.body.title }) }));
const listConversations = asyncHandler(async (req, res) => ok(res, await conversations.listConversations({ actor: req.user, query: req.query })));
const getConversation = asyncHandler(async (req, res) => ok(res, { conversation: await conversations.getConversation({ actor: req.user, id: req.params.id }) }));
const updateConversation = asyncHandler(async (req, res) => ok(res, { conversation: await conversations.updateConversation({ actor: req.user, id: req.params.id, ...req.body }) }));
const deleteConversation = asyncHandler(async (req, res) => ok(res, await conversations.deleteConversation({ actor: req.user, id: req.params.id })));
const listMessages = asyncHandler(async (req, res) => ok(res, await conversations.listMessages({ actor: req.user, id: req.params.id, query: req.query })));
const sendMessage = asyncHandler((req, res) => {
  const options = { actor: req.user, conversationId: req.params.id, content: req.body.content };
  return streamToResponse(req, res, {
    start: (signal) => chat.streamReply({ ...options, signal }),
    collect: (signal) => chat.sendMessage({ ...options, signal }),
  });
});

const embeddingOverview = asyncHandler(async (req, res) => ok(res, { embedding: await embedding.getOverview({ actor: req.user }) }));
const embeddingJobs = asyncHandler(async (req, res) => ok(res, await embedding.listJobs({ actor: req.user, query: req.query })));
const embeddingRetry = asyncHandler(async (req, res) => ok(res, await embedding.retryJob({ actor: req.user, id: req.params.id, req })));
const embeddingReconcile = asyncHandler(async (req, res) => ok(res, { result: await embedding.reconcileNow({ actor: req.user, req }) }));
const embeddingVerify = asyncHandler(async (req, res) => ok(res, { result: await embedding.verifyNow({ actor: req.user, req }) }));
const platformEmbedding = asyncHandler(async (req, res) => ok(res, { embedding: await embedding.getPlatformOverview() }));
const embeddingPromote = asyncHandler(async (req, res) => ok(res, { result: await embedding.promote({ actor: req.user, req }) }));
const embeddingAbandon = asyncHandler(async (req, res) => ok(res, { result: await embedding.abandon({ actor: req.user, req }) }));
const embeddingStart = asyncHandler(async (req, res) => ok(res, { result: await embedding.start({ actor: req.user, req }) }));

module.exports = {
  platformControl,
  updatePlatformControl,
  forUser,
  ask,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  sendMessage,
  updateConversation,
  platformEmbedding,
  embeddingAbandon,
  embeddingJobs,
  embeddingOverview,
  embeddingPromote,
  embeddingReconcile,
  embeddingRetry,
  embeddingStart,
  embeddingVerify,
  disclosure,
  getSettings,
  ingestionJobs,
  ingestionOverview,
  ingestionReconcile,
  ingestionRetry,
  myUsage,
  orgUsage,
  platformStatus,
  platformUsage,
  status,
  updateSettings,
};
