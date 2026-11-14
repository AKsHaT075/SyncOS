const mongoose = require('mongoose');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const AIConversation = require('../../../models/AIConversation');
const AiMessage = require('../../../models/AiMessage');
const { usableDocuments } = require('../rag/knowledgeAccess.service');

/**
 * Private conversations: create / list / read / rename / archive / delete / messages.
 *
 * OWNERSHIP RULE (the whole security model of this module): a conversation is addressed ONLY as { _id, organization, user }
 * where organization and user come from the authenticated session. There is no code path that loads a conversation by id
 * alone, and no role (org-admin, HR, manager, super-admin) widens it. A conversation that does not exist, belongs to
 * someone else or to another organization is the same 404.
 *
 * Message text is never logged, never put in an audit event, never copied into usage records.
 */

const NOT_FOUND = () => new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
const idString = (v) => (v ? v.toString() : null);

const encodeCursor = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (value && typeof value === 'object') return value;
  } catch {
    /* fall through */
  }
  throw new AppError('Invalid cursor', 400, 'VALIDATION_ERROR');
}

/** The owner's scope. Everything below builds on it. */
const ownerScope = (actor) => ({ organization: actor.organization, user: actor._id });

async function findOwned(actor, id, { lean = true } = {}) {
  if (!mongoose.isValidObjectId(id)) throw NOT_FOUND();
  const query = AIConversation.findOne({ _id: id, ...ownerScope(actor) });
  const conversation = await (lean ? query.lean() : query);
  if (!conversation) throw NOT_FOUND();
  return conversation;
}

const cleanTitle = (title) => String(title).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

/** The automatic title: the first question, tidied and shortened. Derived from the user's own words only, never from documents or model output. */
function titleFromQuestion(question) {
  const text = cleanTitle(question);
  if (text.length <= 60) return text || AIConversation.DEFAULT_TITLE;
  const cut = text.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 30)).trim()}…`;
}

const conversationView = (c) => ({
  id: idString(c._id),
  title: c.title,
  titleSource: c.titleSource,
  status: c.status,
  messageCount: c.messageCount,
  lastActivityAt: c.lastActivityAt,
  createdAt: c.createdAt,
  archivedAt: c.archivedAt || null,
  busy: Boolean(c.activeRequestKey && c.leaseExpiresAt && c.leaseExpiresAt > new Date()),
});

async function createConversation({ actor, title }) {
  const count = await AIConversation.countDocuments(ownerScope(actor));
  if (count >= env.AI_CONVERSATION_MAX_PER_USER) throw new AppError('You have reached the maximum number of conversations. Delete some to continue.', 409, 'CONVERSATION_LIMIT');
  const custom = title ? cleanTitle(title) : '';
  const conversation = await AIConversation.create({ ...ownerScope(actor), ...(custom ? { title: custom, titleSource: 'user' } : {}) });
  return conversationView(conversation.toObject());
}

async function listConversations({ actor, query = {} }) {
  const limit = query.limit || 20;
  const filter = { ...ownerScope(actor), status: query.status || 'active' };
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    const at = new Date(cursor.t);
    if (Number.isNaN(at.getTime()) || !mongoose.isValidObjectId(cursor.id)) throw new AppError('Invalid cursor', 400, 'VALIDATION_ERROR');
    filter.$or = [{ lastActivityAt: { $lt: at } }, { lastActivityAt: at, _id: { $lt: cursor.id } }];
  }
  const rows = await AIConversation.find(filter).sort({ lastActivityAt: -1, _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { conversations: page.map(conversationView), nextCursor: rows.length > limit ? encodeCursor({ t: last.lastActivityAt.toISOString(), id: idString(last._id) }) : null };
}

async function getConversation({ actor, id }) {
  return conversationView(await findOwned(actor, id));
}

async function updateConversation({ actor, id, title, archived }) {
  const set = {};
  if (title !== undefined) {
    const clean = cleanTitle(title);
    if (!clean) throw new AppError('A title is required', 400, 'VALIDATION_ERROR');
    set.title = clean;
    set.titleSource = 'user';
  }
  if (archived === true) Object.assign(set, { status: 'archived', archivedAt: new Date() });
  if (archived === false) Object.assign(set, { status: 'active', archivedAt: null, lastActivityAt: new Date() }); // restoring restarts the retention clock
  if (!mongoose.isValidObjectId(id)) throw NOT_FOUND();
  const updated = await AIConversation.findOneAndUpdate({ _id: id, ...ownerScope(actor) }, { $set: set }, { new: true }).lean();
  if (!updated) throw NOT_FOUND();
  return conversationView(updated);
}

/**
 * Permanent. The conversation and ALL its messages are removed (there is no trash for conversations: they are private working
 * notes, and deleting one means deleting it). A reply that is still being generated finishes harmlessly: its writes match nothing.
 * Usage events keep only the conversation id (no content) for billing/quota accuracy.
 */
async function deleteConversation({ actor, id }) {
  if (!mongoose.isValidObjectId(id)) throw NOT_FOUND();
  const removed = await AIConversation.findOneAndDelete({ _id: id, ...ownerScope(actor) }).select('_id').lean();
  if (!removed) throw NOT_FOUND();
  await AiMessage.deleteMany({ conversation: removed._id, ...ownerScope(actor) });
  return { deleted: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Messages

/**
 * Citations stored with a message are re-authorized against the LIVE document rules at read time. A document that was
 * trashed, made private, or whose access was revoked since the answer is shown as unavailable: its name, id and location
 * are not returned. The name shown is the current one.
 */
async function presentCitations(actor, messages) {
  const ids = [...new Set(messages.flatMap((m) => (m.citations || []).map((c) => c.documentId)).filter((id) => mongoose.isValidObjectId(id)))];
  const usable = ids.length ? await usableDocuments(actor, ids) : new Map();
  return (message) =>
    (message.citations || []).map((c) => {
      const doc = usable.get(c.documentId);
      if (!doc) return { n: c.n, available: false };
      return { n: c.n, available: true, chunkId: c.chunkId, documentId: c.documentId, documentName: doc.name, version: c.version, chunkIndex: c.chunkIndex, location: c.location || {}, score: c.score };
    });
}

function messageView(message, citations, conversation) {
  // A reply that says "streaming" while its lease is gone belongs to a request that died: it will never finish.
  const lost = message.status === 'streaming' && (!conversation || conversation.activeRequestKey !== message.requestKey || !conversation.leaseExpiresAt || conversation.leaseExpiresAt <= new Date());
  return {
    id: idString(message._id),
    seq: message.seq,
    role: message.role,
    content: message.content,
    status: lost ? 'incomplete' : message.status,
    finishReason: lost ? message.finishReason || 'interrupted' : message.finishReason,
    errorCode: message.errorCode,
    citations: citations(message),
    createdAt: message.createdAt,
  };
}

async function presentMessages(actor, conversation, messages) {
  const citations = await presentCitations(actor, messages);
  return messages.map((m) => messageView(m, citations, conversation));
}

/** Newest page first by default; `nextCursor` pages BACK in time. Each page is returned oldest-to-newest so it can be rendered directly. */
async function listMessages({ actor, id, query = {} }) {
  const conversation = await findOwned(actor, id);
  const limit = query.limit || 50;
  const filter = { conversation: conversation._id, ...ownerScope(actor) };
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    if (!Number.isInteger(cursor.seq)) throw new AppError('Invalid cursor', 400, 'VALIDATION_ERROR');
    filter.seq = { $lt: cursor.seq };
  }
  const rows = await AiMessage.find(filter).sort({ seq: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit).reverse();
  return { messages: await presentMessages(actor, conversation, page), nextCursor: rows.length > limit ? encodeCursor({ seq: page[0].seq }) : null };
}

module.exports = {
  cleanTitle,
  conversationView,
  createConversation,
  deleteConversation,
  findOwned,
  getConversation,
  listConversations,
  listMessages,
  messageView,
  ownerScope,
  presentMessages,
  titleFromQuestion,
  updateConversation,
};
