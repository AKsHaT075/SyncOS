const crypto = require('crypto');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const { AI_ERROR_CODES, AI_FEATURES } = require('../../../constants/ai.constants');
const { streamAiRequest } = require('../aiPipeline.service');
const { assertAiAvailable, liveToolsEligibility } = require('../aiSettings.service');
const aiService = require('../aiService');
const spaces = require('../embedding/embeddingSpaces.service');
const { isSupportedLanguage, UNSUPPORTED_LANGUAGE_MESSAGE } = require('../../../utils/languagePolicy');
const { confirmCitations, forgetAuthorized } = require('./knowledgeAccess.service');

/**
 * Answer one question from the organization's documents. This is the single entry point for retrieval-augmented answers;
 * it rides the EXISTING metered pipeline (gate -> admit -> reserve -> engine -> settle -> record), and adds two things:
 *   1. the embedding space that is ACTIVE is signed into the request, so Python cannot search an incompatible space
 *   2. the `citations` event that comes back is re-checked here against the chunks Node itself authorized for this
 *      request: a reference Node did not authorize is never shown, whatever Python or the model produced.
 */

function validateQuestion(question) {
  if (typeof question !== 'string') throw new AppError('A question is required', 400, 'VALIDATION_ERROR');
  const trimmed = question.trim();
  if (!trimmed) throw new AppError('A question is required', 400, 'VALIDATION_ERROR');
  if (trimmed.length > env.AI_RAG_MAX_QUESTION_CHARS) throw new AppError(`The question is too long (max ${env.AI_RAG_MAX_QUESTION_CHARS} characters)`, 400, 'VALIDATION_ERROR');
  return trimmed;
}

/**
 * The reply to a question outside the supported language: fixed text, no retrieval, no model call, no usage, no charge.
 * Same event shape as an answer, so callers need no special case.
 */
async function* unsupportedLanguageEvents() {
  yield { type: 'text', text: UNSUPPORTED_LANGUAGE_MESSAGE };
  yield { type: 'citations', citations: [], droppedCitations: 0, unverifiedMarkers: [], uncited: true };
  yield { type: 'done', finishReason: 'unsupported_language' };
}

// What the model is told when it may use live tools but there are no document sources (Python appends its tool rules to this first system message).
const LIVE_TOOLS_SYSTEM = 'You are the Sync OS assistant for a company workspace. Be brief. Use the tools only when the question needs live workspace data.';

/**
 * `history`: earlier turns of the SAME conversation ({role, content}), used only to make a follow-up searchable (documents) or as plain context (tools).
 *
 * THREE modes, decided on the server from facts it reads fresh, never from the request:
 *   rag     (the default, and the ONLY mode unless live tools are activated + eligible)  documents only. The 503 below when the index is not ready.
 *   hybrid  live tools eligible AND document retrieval available: Python retrieves, Node authorizes the chunks, the tool loop may ALSO call tools. Two
 *           channels (sources in the user message, tool results as tool messages), two tokens, two authorizations: never mixed.
 *   tools   live tools eligible but no document index / retrieval: tools only.
 * `liveToolsEligibility` never throws and means: the deploy-time flag is on, and the user, role, AI + live-data settings and the platform emergency switches
 * all allow it RIGHT NOW. If anything is off, the request simply stays a document answer: no budget is opened.
 */
async function* streamAnswer({ actor, question, signal, conversationId = null, history = [], requestKey: givenKey = null }) {
  const text = validateQuestion(question);
  await assertAiAvailable({ actor }); // fail early (and cheaply) before looking at the index state
  if (!isSupportedLanguage(text)) {
    yield* unsupportedLanguageEvents();
    return;
  }
  const cfg = await spaces.getConfig();
  const indexReady = Boolean(cfg && cfg.activeSpaceId);
  let mode = 'rag';
  if ((await liveToolsEligibility({ actor })).eligible) {
    const platform = await aiService.platformStatus();
    mode = indexReady && platform.retrievalEnabled !== false ? 'hybrid' : 'tools';
  } else if (!indexReady) {
    throw new AppError('The document search index is not ready yet', 503, AI_ERROR_CODES.KNOWLEDGE_NOT_READY);
  }

  const requestKey = givenKey || crypto.randomUUID();
  const ragRequest = { question: text, spaceId: cfg?.activeSpaceId, ...(history.length ? { history } : {}) };
  const options = {
    rag: { feature: AI_FEATURES.DOCUMENT_QA, messages: [{ role: 'user', content: text }], rag: ragRequest }, // `messages` is sized for the reservation; Python builds the real prompt
    hybrid: { feature: AI_FEATURES.TOOLS, messages: [{ role: 'user', content: text }], rag: ragRequest, toolBudget: true },
    tools: { feature: AI_FEATURES.TOOLS, toolBudget: true, messages: [{ role: 'system', content: LIVE_TOOLS_SYSTEM }, ...history.filter((h) => h.role === 'user' || h.role === 'assistant').map((h) => ({ role: h.role, content: String(h.content) })), { role: 'user', content: text }] },
  }[mode];
  try {
    for await (const event of streamAiRequest({ actor, conversationId, requestKey, signal, ...options })) {
      if (event.type === 'citations') {
        const { citations, dropped } = await confirmCitations(requestKey, event.citations);
        yield { ...event, citations, droppedCitations: dropped };
      } else {
        yield event;
      }
    }
  } finally {
    await forgetAuthorized(requestKey);
  }
}

/** Non-streaming convenience: the whole answer as one object. */
async function answerQuestion(options) {
  let answer = '';
  let citations = [];
  let retrieval = null;
  let usage = null;
  let finishReason = null;
  let meta = {};
  for await (const event of streamAnswer(options)) {
    if (event.type === 'text') answer += event.text;
    else if (event.type === 'citations') meta = { droppedCitations: event.droppedCitations, unverifiedMarkers: event.unverifiedMarkers, uncited: event.uncited };
    else if (event.type === 'retrieval') retrieval = event;
    else if (event.type === 'usage') usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens, estimated: event.estimated };
    else if (event.type === 'done') finishReason = event.finishReason;
    if (event.type === 'citations') citations = event.citations;
  }
  return { answer, citations, retrieval, usage, finishReason, ...meta };
}

module.exports = { answerQuestion, streamAnswer, unsupportedLanguageEvents, validateQuestion };
