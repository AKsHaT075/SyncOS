const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema(
  {
    pageStart: Number,
    pageEnd: Number,
    headingPath: { type: [String], default: undefined },
    sheet: String,
    rowStart: Number,
    rowEnd: Number,
    slideStart: Number,
    slideEnd: Number,
    charStart: Number,
    charEnd: Number,
  },
  { _id: false },
);

/**
 * A retrievable slice of one document version. Carries NO access-control data on purpose: who may read a
 * chunk is decided by Node from the live Document at retrieval time, never from anything stored here.
 * A chunk is only trustworthy while the matching DocumentIngestionJob is `indexed` and its version is still
 * the document's current version (see chunkStore.service). No embedding fields yet.
 */
const chunkSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    version: { type: Number, required: true },
    pipelineVersion: { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true },
    textHash: { type: String, required: true },
    tokenEstimate: { type: Number, required: true }, // chars/4 approximation, not a tokenizer count
    location: { type: locationSchema, default: () => ({}) },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

chunkSchema.index({ organization: 1, document: 1, version: 1, pipelineVersion: 1, chunkIndex: 1 }, { unique: true });
chunkSchema.index({ organization: 1, document: 1 });

module.exports = mongoose.model('DocumentChunk', chunkSchema);
