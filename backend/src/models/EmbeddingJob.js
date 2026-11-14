const mongoose = require('mongoose');
const { ANY_PIPELINE, EMBEDDING_KIND, EMBEDDING_STATUS } = require('../constants/embedding.constants');

/**
 * Durable embedding work, one row per (organization, document, kind, version, ingestionPipeline, spaceId).
 *   embed  - make the vectors of ONE document version exist in ONE embedding space (idempotent "sync to desired state")
 *   purge  - remove a document's vectors from ONE space (all versions, or all but `keepVersion`)
 * MongoDB is the source of truth; Qdrant is a rebuildable index. The row never holds text or vectors.
 */
const schema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    document: { type: mongoose.Schema.Types.ObjectId, required: true }, // deliberately NOT a live ref: purge rows outlive the document
    kind: { type: String, enum: Object.values(EMBEDDING_KIND), required: true },
    version: { type: Number, default: 0 }, // embed: the document version; purge: 0
    ingestionPipeline: { type: String, default: ANY_PIPELINE },
    spaceId: { type: String, required: true },

    status: { type: String, enum: Object.values(EMBEDDING_STATUS), default: EMBEDDING_STATUS.QUEUED },
    reason: { type: String, default: null },
    source: { type: String, default: 'ingestion' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextRunAt: { type: Date, default: () => new Date() },

    lockToken: { type: String, default: null, select: false },
    lockedBy: { type: String, default: null },
    lockExpiresAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },

    // embed results (counts and a digest only)
    chunkCount: { type: Number, default: 0 },
    digest: { type: String, default: null }, // sha256 over the ordered chunk text hashes this job covered
    embeddedAt: { type: Date, default: null },
    lastVerifiedAt: { type: Date, default: null },

    // purge requests
    keepVersion: { type: Number, default: null },
    generation: { type: Number, default: 0 }, // bumped by every request; a result for an older generation does not complete the row
  },
  { timestamps: true },
);

schema.index({ organization: 1, document: 1, kind: 1, version: 1, ingestionPipeline: 1, spaceId: 1 }, { unique: true });
schema.index({ status: 1, nextRunAt: 1, spaceId: 1 }); // claim
schema.index({ status: 1, lockExpiresAt: 1 }); // stale recovery
schema.index({ organization: 1, kind: 1, status: 1, updatedAt: -1 }); // admin
schema.index({ spaceId: 1, kind: 1, status: 1 }); // coverage / migration
schema.index({ organization: 1, document: 1 });

schema.methods.toSafeObject = function toSafeObject() {
  return {
    id: this._id.toString(),
    documentId: this.document.toString(),
    kind: this.kind,
    version: this.kind === EMBEDDING_KIND.EMBED ? this.version : null,
    spaceId: this.spaceId,
    ingestionPipeline: this.ingestionPipeline === ANY_PIPELINE ? null : this.ingestionPipeline,
    status: this.status,
    reason: this.reason,
    attempts: this.attempts,
    maxAttempts: this.maxAttempts,
    nextRunAt: [EMBEDDING_STATUS.QUEUED, EMBEDDING_STATUS.FAILED].includes(this.status) ? this.nextRunAt : null,
    chunkCount: this.chunkCount,
    embeddedAt: this.embeddedAt,
    lastVerifiedAt: this.lastVerifiedAt,
    keepVersion: this.keepVersion,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('EmbeddingJob', schema);
