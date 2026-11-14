const mongoose = require('mongoose');
const { INGESTION_STATUS } = require('../constants/ingestion.constants');

/**
 * One row per (organization, document, version, pipelineVersion). MongoDB is the durable source of truth;
 * Redis is only used to coordinate the periodic sweep. The row never holds document text.
 */
const jobSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    version: { type: Number, required: true },
    pipelineVersion: { type: String, required: true },

    status: { type: String, enum: Object.values(INGESTION_STATUS), default: INGESTION_STATUS.QUEUED },
    reason: { type: String, default: null }, // machine-readable skip / failure code, never a message from a parser
    format: { type: String, default: null },
    extension: { type: String, default: null },
    size: { type: Number, default: 0 },
    checksum: { type: String, required: true }, // sha256 of the version's bytes when the job was created
    source: { type: String, enum: ['upload', 'version', 'restore', 'reconcile', 'admin'], default: 'upload' },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextRunAt: { type: Date, default: () => new Date() },

    // Claim / lease. The token fences stale workers: only its holder may heartbeat or submit.
    lockToken: { type: String, default: null, select: false },
    lockedBy: { type: String, default: null },
    lockExpiresAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },

    stats: { type: mongoose.Schema.Types.Mixed, default: null }, // counts only (pages, sheets, chunkCount, ...)
  },
  { timestamps: true },
);

jobSchema.index({ organization: 1, document: 1, version: 1, pipelineVersion: 1 }, { unique: true });
jobSchema.index({ status: 1, nextRunAt: 1 }); // claim
jobSchema.index({ status: 1, lockExpiresAt: 1 }); // stale-lock recovery
jobSchema.index({ organization: 1, status: 1, updatedAt: -1 }); // admin listing
jobSchema.index({ organization: 1, document: 1 });

jobSchema.methods.toSafeObject = function toSafeObject() {
  return {
    id: this._id.toString(),
    documentId: this.document.toString(),
    version: this.version,
    pipelineVersion: this.pipelineVersion,
    status: this.status,
    reason: this.reason,
    format: this.format,
    extension: this.extension,
    size: this.size,
    attempts: this.attempts,
    maxAttempts: this.maxAttempts,
    nextRunAt: this.status === INGESTION_STATUS.FAILED || this.status === INGESTION_STATUS.QUEUED ? this.nextRunAt : null,
    stats: this.stats || null,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('DocumentIngestionJob', jobSchema);
