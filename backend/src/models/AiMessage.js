const mongoose = require('mongoose');

/**
 * One message of a private conversation. `organization` and `user` are copied from the conversation so that every query can
 * (and must) filter by owner directly.
 *
 * status:  streaming  the reply is being generated (a crashed one is swept to `incomplete`)
 *          complete   finished normally
 *          incomplete the client cancelled, or the stream broke after some text; `content` is what was produced
 *          error      the reply failed (nothing useful was produced)
 *
 * Citations are stored as they were CONFIRMED by Node at answer time. They are re-authorized against the live document
 * rules every time they are read, so a revoked document's name never reappears.
 * Never logged. Not trusted organizational knowledge: it is only ever used to understand a follow-up question.
 */
const citationSchema = new mongoose.Schema(
  {
    n: Number,
    chunkId: String,
    documentId: String,
    documentName: String,
    version: Number,
    chunkIndex: Number,
    location: { type: mongoose.Schema.Types.Mixed, default: {} },
    score: Number,
  },
  { _id: false },
);

const aiMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'AIConversation', required: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    seq: { type: Number, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '', maxlength: 60000 },
    status: { type: String, enum: ['streaming', 'complete', 'incomplete', 'error'], default: 'complete' },
    finishReason: { type: String, default: null },
    errorCode: { type: String, default: null },
    citations: { type: [citationSchema], default: [] },
    requestKey: { type: String, default: null }, // links to the usage event; no content
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, strict: true },
);

aiMessageSchema.index({ conversation: 1, seq: 1 }, { unique: true });
aiMessageSchema.index({ organization: 1, user: 1, conversation: 1, seq: -1 });
aiMessageSchema.index({ status: 1, createdAt: 1 }, { partialFilterExpression: { status: 'streaming' } });

module.exports = mongoose.model('AiMessage', aiMessageSchema);
