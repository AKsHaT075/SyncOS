const mongoose = require('mongoose');
const { ASSET_STATUS, CURRENCIES, DEFAULT_CURRENCY, MAINTENANCE_STATUS, MAINTENANCE_TYPE } = require('../constants/asset.constants');

const { ObjectId } = mongoose.Schema.Types;

const maintenanceSchema = new mongoose.Schema(
  {
    organization: { type: ObjectId, ref: 'Organization', required: true },
    asset: { type: ObjectId, ref: 'Asset', required: true },
    type: { type: String, enum: Object.values(MAINTENANCE_TYPE), default: MAINTENANCE_TYPE.REPAIR },
    status: { type: String, enum: Object.values(MAINTENANCE_STATUS), required: true },
    issue: { type: String, required: true, trim: true, maxlength: 2000 },
    serviceProvider: { type: String, default: '', trim: true, maxlength: 150 },
    vendor: { type: ObjectId, ref: 'AssetVendor', default: null },

    // Date-only (UTC midnight): when the work is planned, and when it was actually started/finished.
    scheduledDate: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    nextMaintenanceDate: { type: Date, default: null },

    cost: { type: Number, default: null, min: 0 },
    currency: { type: String, enum: CURRENCIES, default: DEFAULT_CURRENCY },
    repairNotes: { type: String, default: '', trim: true, maxlength: 5000 },

    // Employee-submitted requests: who asked, and who approved or declined.
    reportedBy: { type: ObjectId, ref: 'User', default: null },
    requestedAt: { type: Date, default: null },
    decidedBy: { type: ObjectId, ref: 'User', default: null },
    declineReason: { type: String, default: '', trim: true, maxlength: 500 },

    // The asset's status when work started, restored when it ends.
    assetStatusBefore: { type: String, enum: [...Object.values(ASSET_STATUS), null], default: null },

    createdBy: { type: ObjectId, ref: 'User', required: true },
    updatedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

maintenanceSchema.index({ organization: 1, asset: 1, createdAt: -1 });
maintenanceSchema.index({ organization: 1, status: 1, scheduledDate: 1 });
// At most one piece of work in progress per asset (guards concurrent "start" requests).
maintenanceSchema.index({ asset: 1 }, { unique: true, partialFilterExpression: { status: MAINTENANCE_STATUS.IN_PROGRESS } });

module.exports = mongoose.model('AssetMaintenance', maintenanceSchema);
