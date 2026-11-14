const crypto = require('crypto');
const mongoose = require('mongoose');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const { AI_ERROR_CODES } = require('../../../constants/ai.constants');
const AIConversation = require('../../../models/AIConversation');
const AiMessage = require('../../../models/AiMessage');
const { isSupportedLanguage } = require('../../../utils/languagePolicy');
const { assertAiAvailable } = require('../aiSettings.service');
const { streamAnswer, unsupportedLanguageEvents, validateQuestion } = require('../rag/ask.service');
const spaces = require('../embedding/embeddingSpaces.service');
const { findOwned, messageView, ownerScope, presentMessages, titleFromQuestion } = require('./conversation.service');

/**
 * One turn of a persistent conversation: the user's message, then a streamed, cited, metered answer.
 *
 *   1. ownership (404) -> input validation -> AI availability -> index readiness
 *   2. atomically CLAIM the conversation (one reply at a time) and reserve two sequence numbers
 *   3. persist the user message and an empty assistant message (`streaming`)
 *   4. run the existing RAG pipeline (live authorization, metering, settlement: all unchanged, all in Node)
 *   5. persist the assistant message: complete | incomplete (cancelled / cut off) | error. Release the claim.
 *
 * Anything that fails BEFORE the first event (quota, rate limit, retrieval unavailable, ...) is an ordinary HTTP error and the two
 * messages are rolled back, so a refused question leaves no trace in the transcript. After the first event the transcript
 * keeps whatever happened, truthfully.
 *
 * Follow-ups: the last few COMPLETE exchanges are passed to the AI service ONLY to rewrite the new question so it can be searched.
 * History is never a source of facts; the answer is built from freshly authorized documents only.
 */

const BUSY = () => new AppError('This conversation is still answering. Wait for the reply to finish or cancel it.', 409, 'CONVERSATION_BUSY');
const IDEAL_HISTORY_QUESTION_CHARS = 500;
const IDEAL_HISTORY_ANSWER_CHARS = 400;

async function recentHistory({ actor, conversationId, beforeSeq }) {
  const turns = env.AI_CONVERSATION_HISTORY_TURNS;
  const rows = await AiMessage.find({ conversation: conversationId, ...ownerScope(actor), seq: { $lt: beforeSeq }, status: 'complete' })
    .sort({ seq: -1 })
    .limit(turns * 2 + 6)
    .select('seq role content finishReason')
    .lean();
  const bySeq = new Map(rows.map((m) => [m.seq, m]));
  const pairs = [];
  for (const answer of rows) {
    if (answer.role !== 'assistant' || answer.finishReason !== 'stop') continue; // refusals, "not found", unsupported-language replies carry no context worth keeping
    const question = bySeq.get(answer.seq - 1);
    if (question && question.role === 'user') pairs.push([question, answer]);
    if (pairs.length >= turns) break;
  }
  return pairs
    .reverse()
    .flatMap(([q, a]) => [
      { role: 'user', content: q.content.slice(0, IDEAL_HISTORY_QUESTION_CHARS) },
      { role: 'assistant', content: a.content.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, IDEAL_HISTORY_ANSWER_CHARS) },
    ])
    .filter((m) => m.content);
}

/** Atomically takes the conversation for one reply. Returns the conversation BEFORE the claim (its nextSeq is ours). */
async function claim({ actor, conversationId, requestKey }) {
  const now = new Date();
  const before = await AIConversation.findOneAndUpdate(
    {
      _id: conversationId,
      ...ownerScope(actor),
      status: 'active',
      messageCount: { $lte: env.AI_CONVERSATION_MAX_MESSAGES - 2 },
      $or: [{ activeRequestKey: null }, { leaseExpiresAt: { $lt: now } }],
    },
    { $set: { activeRequestKey: requestKey, leaseExpiresAt: new Date(now.getTime() + env.AI_CONVERSATION_LEASE_SECONDS * 1000), lastActivityAt: now }, $inc: { nextSeq: 2, messageCount: 2 } },
    { new: false },
  ).lean();
  if (before) {
    if (before.activeRequestKey) {
      // The previous reply's request died without finishing (its lease ran out): its message can never complete.
      await AiMessage.updateMany({ conversation: before._id, ...ownerScope(actor), status: 'streaming' }, { $set: { status: 'incomplete', finishReason: 'interrupted' } });
    }
    return before;
  }
  const current = await findOwned(actor, conversationId); // 404 if it vanished meanwhile
  if (current.status === 'archived') throw new AppError('This conversation is archived. Restore it to continue.', 409, 'CONVERSATION_ARCHIVED');
  if (current.messageCount > env.AI_CONVERSATION_MAX_MESSAGES - 2) throw new AppError('This conversation has reached its length limit. Start a new conversation.', 409, 'CONVERSATION_FULL');
  throw BUSY();
}

const releaseClaim = (actor, conversationId, requestKey, extra = {}) =>
  AIConversation.updateOne({ _id: conversationId, ...ownerScope(actor), activeRequestKey: requestKey }, { $set: { activeRequestKey: null, leaseExpiresAt: null, ...extra } });

async function begin({ actor, conversationId, content }) {
  const text = validateQuestion(content);
  if (!mongoose.isValidObjectId(conversationId)) throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
  const owned = await findOwned(actor, conversationId); // ownership BEFORE anything else: another user's id is a 404, whatever else is wrong with the request
  if (owned.status === 'archived') throw new AppError('This conversation is archived. Restore it to continue.', 409, 'CONVERSATION_ARCHIVED');
  await assertAiAvailable({ actor });
  const supported = isSupportedLanguage(text);
  if (supported) {
    const cfg = await spaces.getConfig();
    if (!cfg || !cfg.activeSpaceId) throw new AppError('The document search index is not ready yet', 503, AI_ERROR_CODES.KNOWLEDGE_NOT_READY);
  }

  const requestKey = crypto.randomUUID();
  const before = await claim({ actor, conversationId, requestKey });
  const turn = { actor, conversationId: before._id, requestKey, supported, text, userSeq: before.nextSeq, assistantSeq: before.nextSeq + 1, userMessageId: null, assistantMessageId: null };
  try {
    const history = supported ? await recentHistory({ actor, conversationId: before._id, beforeSeq: before.nextSeq }) : [];
    const [userMessage, assistantMessage] = await AiMessage.insertMany(
      [
        { conversation: before._id, ...ownerScope(actor), seq: turn.userSeq, role: 'user', content: text, status: 'complete', requestKey },
        { conversation: before._id, ...ownerScope(actor), seq: turn.assistantSeq, role: 'assistant', content: '', status: 'streaming', requestKey },
      ],
      { ordered: true },
    );
    turn.userMessageId = userMessage._id;
    turn.assistantMessageId = assistantMessage._id;
    turn.history = history;
    if (before.titleSource === 'auto' && before.title === AIConversation.DEFAULT_TITLE) {
      await AIConversation.updateOne({ _id: before._id, ...ownerScope(actor), titleSource: 'auto', title: AIConversation.DEFAULT_TITLE }, { $set: { title: titleFromQuestion(text) } });
    }
  } catch (error) {
    await rollback(turn);
    throw error;
  }
  return turn;
}

/** The question never produced anything: remove the pair and give the sequence/slots back. */
async function rollback(turn) {
  try {
    const removed = await AiMessage.deleteMany({ conversation: turn.conversationId, ...ownerScope(turn.actor), requestKey: turn.requestKey });
    await AIConversation.updateOne(
      { _id: turn.conversationId, ...ownerScope(turn.actor), activeRequestKey: turn.requestKey },
      { $set: { activeRequestKey: null, leaseExpiresAt: null }, $inc: { messageCount: -2 } },
    );
    return removed;
  } catch (error) {
    console.error('[ai-conversation] rollback failed:', error.name);
    return null;
  }
}

const storedCitation = (c) => ({ n: c.n, chunkId: c.chunkId, documentId: c.documentId, documentName: c.documentName, version: c.version, chunkIndex: c.chunkIndex, location: c.location || {}, score: c.score });

/** Writes the assistant message's final state and releases the claim. Never throws: bookkeeping must not replace the real outcome. */
async function settle(turn, { status, content, finishReason, errorCode = null, citations = [] }) {
  try {
    await AiMessage.updateOne(
      { _id: turn.assistantMessageId, ...ownerScope(turn.actor), status: 'streaming' }, // conditional: a swept or deleted message is left alone
      { $set: { status, content: content.slice(0, 60000), finishReason, errorCode, citations: citations.map(storedCitation) } },
    );
    await releaseClaim(turn.actor, turn.conversationId, turn.requestKey, { lastActivityAt: new Date() });
  } catch (error) {
    console.error('[ai-conversation] settle failed:', error.name);
  }
}

/**
 * Streams one turn. Events: `meta` (ids) first, then the same events as /ask (retrieval, text, usage, citations), then `done`.
 * Errors before the first event are thrown (HTTP errors); later failures are thrown too after the transcript has been settled.
 */
async function* streamReply({ actor, conversationId, content, signal }) {
  const turn = await begin({ actor, conversationId, content });
  const inner = turn.supported ? streamAnswer({ actor, question: turn.text, signal, conversationId: turn.conversationId, history: turn.history, requestKey: turn.requestKey }) : unsupportedLanguageEvents();

  let emitted = false;
  let settled = false;
  let text = '';
  let citations = [];
  let doneEvent = null;
  try {
    for await (const event of inner) {
      if (!emitted) {
        emitted = true;
        yield { type: 'meta', conversationId: turn.conversationId.toString(), userMessageId: turn.userMessageId.toString(), assistantMessageId: turn.assistantMessageId.toString() };
      }
      if (event.type === 'text') text += event.text;
      else if (event.type === 'citations') citations = event.citations;
      else if (event.type === 'done') {
        doneEvent = event; // sent only AFTER the transcript is saved, so a client that reacts to `done` can read it back
        continue;
      }
      yield event;
    }
    settled = true;
    if (!doneEvent) {
      await settle(turn, { status: 'error', content: text, finishReason: 'error', errorCode: AI_ERROR_CODES.INVALID_RESPONSE });
      throw new AppError('The request could not be completed', 502, AI_ERROR_CODES.INVALID_RESPONSE);
    }
    await settle(turn, { status: 'complete', content: text, finishReason: doneEvent.finishReason, citations });
    yield { type: 'done', finishReason: doneEvent.finishReason, messageId: turn.assistantMessageId.toString() };
  } catch (error) {
    if (!settled) {
      settled = true;
      if (signal?.aborted || error.code === AI_ERROR_CODES.ABORTED) {
        // The user (or their browser) cancelled: they DID submit this message, so it is kept, with an incomplete reply, even if no assistant frame had
        // arrived yet (a tool-enabled answer is buffered, so that window can be seconds long). Rolling it back would silently lose their question.
        await settle(turn, { status: 'incomplete', content: text, finishReason: 'cancelled', errorCode: AI_ERROR_CODES.ABORTED });
      } else if (!emitted) {
        await rollback(turn); // the request was REFUSED before anything started (quota, service down...): nothing was accepted, the draft goes back to the composer
      } else {
        await settle(turn, { status: text ? 'incomplete' : 'error', content: text, finishReason: 'error', errorCode: error.code || 'AI_INTERNAL_ERROR' });
      }
    }
    throw error;
  } finally {
    // The consumer stopped iterating (client went away) while we were suspended at a yield: a cancelled, partial reply.
    if (!settled) {
      settled = true;
      await settle(turn, { status: 'incomplete', content: text, finishReason: 'cancelled', errorCode: AI_ERROR_CODES.ABORTED }); // the consumer went away: same as a cancel
    }
  }
}

/** Non-streaming: the whole turn as one object, with the stored messages read back (citations re-authorized like any read). */
async function sendMessage({ actor, conversationId, content, signal }) {
  let meta = null;
  let retrieval = null;
  let usage = null;
  let finishReason = null;
  for await (const event of streamReply({ actor, conversationId, content, signal })) {
    if (event.type === 'meta') meta = event;
    else if (event.type === 'retrieval') retrieval = { sourcesUsed: event.used };
    else if (event.type === 'usage') usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens, estimated: event.estimated };
    else if (event.type === 'done') finishReason = event.finishReason;
  }
  const conversation = await findOwned(actor, conversationId);
  const rows = await AiMessage.find({ _id: { $in: [meta.userMessageId, meta.assistantMessageId] }, ...ownerScope(actor) }).sort({ seq: 1 }).lean();
  const [userMessage, assistantMessage] = await presentMessages(actor, conversation, rows);
  return { userMessage, assistantMessage, retrieval, usage, finishReason };
}

module.exports = { messageView, sendMessage, streamReply };
