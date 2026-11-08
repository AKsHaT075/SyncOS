const mongoose = require('mongoose');
const { ASSET_CONDITION, ASSIGNEE_TYPE, ASSIGNMENT_STATUS, CLOSE_REASON } = require('../constants/asset.constants');

const { ObjectId } = mongoose.Schema.Types;

/**
 * One row per period an asset (or one license seat) is held. Rows are IMMUTABLE history: the identity fields
 * below can't be changed after creation; a transfer or return only CLOSES the row (status, closedAt,
 * returnedCondition…) and a transfer opens a NEW one. Nothing is ever deleted, including when the assignee later
 * leaves the organization.
 *
 * Two partial unique indexes make double-assignment impossible at the database level, whatever the application does:
 *   - hardware: at most one ACTIVE assignment per asset
 *   - software: at most one ACTIVE assignment per (asset, user) — a person holds a given license once
 */
const assignmentSchema = new mongoose.Schema(
  {
    organization: { type: ObjectId, ref: 'Organization', required: true, immutable: true },
    asset: { type: ObjectId, ref: 'Asset', required: true, immutable: true },
    exclusive: { type: Boolean, required: true, immutable: true }, // true = hardware (one holder), false = license seat
    assigneeType: { type: String, enum: Object.values(ASSIGNEE_TYPE), required: true, immutable: true },
    user: { type: ObjectId, ref: 'User', default: null, immutable: true },
    team: { type: ObjectId, ref: 'Team', default: null, immutable: true },
    assignedBy: { type: ObjectId, ref: 'User', required: true, immutable: true },
    assignedAt: { type: Date, default: Date.now, immutable: true },
    expectedReturnAt: { type: Date, default: null, immutable: true },
    notes: { type: String, default: '', trim: true, maxlength: 1000, immutable: true },
    conditionAtAssignment: { type: String, enum: Object.values(ASSET_CONDITION), default: ASSET_CONDITION.GOOD, immutable: true },
    previousAssignment: { type: ObjectId, ref: 'AssetAssignment', default: null, immutable: true }, // set on transfers

    // --- the only fields that change, once, when the assignment ends ---
    status: { type: String, enum: Object.values(ASSIGNMENT_STATUS), default: ASSIGNMENT_STATUS.ACTIVE },
    closeReason: { type: String, enum: [...Object.values(CLOSE_REASON), null], default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: ObjectId, ref: 'User', default: null },
    returnedCondition: { type: String, enum: [...Object.values(ASSET_CONDITION), null], default: null },
    returnNotes: { type: String, default: '', trim: true, maxlength: 1000 },
    returnRequestedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

assignmentSchema.index({ asset: 1 }, { unique: true, partialFilterExpression: { status: ASSIGNMENT_STATUS.ACTIVE, exclusive: true } });
assignmentSchema.index({ asset: 1, user: 1 }, { unique: true, partialFilterExpression: { status: ASSIGNMENT_STATUS.ACTIVE, exclusive: false } });
assignmentSchema.index({ organization: 1, asset: 1, assignedAt: -1 });
assignmentSchema.index({ organization: 1, user: 1, status: 1 });
assignmentSchema.index({ organization: 1, team: 1, status: 1 });
assignmentSchema.index({ organization: 1, status: 1, assignedAt: -1 });

module.exports = mongoose.model('AssetAssignment', assignmentSchema);
