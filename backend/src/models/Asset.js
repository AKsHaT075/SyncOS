const mongoose = require('mongoose');
const {
  ASSET_CONDITION, ASSET_KIND, ASSET_STATUS, CURRENCIES, DEFAULT_CURRENCY, LICENSE_TYPE, LIMITS,
} = require('../constants/asset.constants');

const { ObjectId } = mongoose.Schema.Types;

// Software licenses: one seat per assignee. `keyReference` is a POINTER to where the key lives (a vault item
// or ticket) — the actual secret is never stored here, and the API only reveals the pointer to license managers.
const licenseSchema = new mongoose.Schema(
  {
    licenseType: { type: String, enum: Object.values(LICENSE_TYPE), default: LICENSE_TYPE.SUBSCRIPTION },
    seats: { type: Number, required: true, min: 1, max: LIMITS.MAX_SEATS },
    // Counter kept in step with ACTIVE assignments via atomic, guarded updates; AssetAssignment is the source
    // of truth and the integrity job recomputes this if the two ever disagree.
    allocatedSeats: { type: Number, default: 0, min: 0 },
    startDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    renewalDate: { type: Date, default: null },
    autoRenew: { type: Boolean, default: false },
    cost: { type: Number, default: null, min: 0 },
    currency: { type: String, enum: CURRENCIES, default: DEFAULT_CURRENCY },
    keyReference: { type: String, default: '', trim: true, maxlength: 200 },
  },
  { _id: false },
);

const statusEntrySchema = new mongoose.Schema(
  {
    from: String,
    to: String,
    action: String,
    at: { type: Date, default: Date.now },
    by: { type: ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
  },
  { _id: false },
);

/**
 * Dates here (purchase, warranty, license) are DATE-ONLY values stored at UTC midnight and shown as the same
 * calendar day in every timezone — the same convention as task and project due dates.
 */
const assetSchema = new mongoose.Schema(
  {
    organization: { type: ObjectId, ref: 'Organization', required: true },
    assetId: { type: String, required: true }, // AST-000123, allocated from an atomic per-organization counter
    assetTag: { type: String, trim: true, maxlength: 60 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    kind: { type: String, enum: Object.values(ASSET_KIND), default: ASSET_KIND.HARDWARE },
    category: { type: ObjectId, ref: 'AssetCategory', required: true },
    subcategory: { type: String, default: '', trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true, maxlength: 2000 },
    brand: { type: String, default: '', trim: true, maxlength: 100 },
    model: { type: String, default: '', trim: true, maxlength: 100 },
    manufacturer: { type: String, default: '', trim: true, maxlength: 100 },
    serialNumber: { type: String, trim: true, maxlength: 100 },

    purchase: {
      date: { type: Date, default: null },
      cost: { type: Number, default: null, min: 0 },
      currency: { type: String, enum: CURRENCIES, default: DEFAULT_CURRENCY },
      vendor: { type: ObjectId, ref: 'AssetVendor', default: null },
      invoiceReference: { type: String, default: '', trim: true, maxlength: 100 },
      purchaseOrderReference: { type: String, default: '', trim: true, maxlength: 100 },
    },

    status: { type: String, enum: Object.values(ASSET_STATUS), default: ASSET_STATUS.AVAILABLE },
    // Where the asset was before it went into maintenance, so finishing maintenance can restore it.
    statusBeforeMaintenance: { type: String, enum: [...Object.values(ASSET_STATUS), null], default: null },
    condition: { type: String, enum: Object.values(ASSET_CONDITION), default: ASSET_CONDITION.GOOD },
    location: { type: String, default: '', trim: true, maxlength: 150 },
    // "Department" = the team that owns/budgets the asset (independent of who currently holds it).
    team: { type: ObjectId, ref: 'Team', default: null },

    // Current holder. History lives in AssetAssignment and is never rewritten.
    assignedUser: { type: ObjectId, ref: 'User', default: null },
    assignedTeam: { type: ObjectId, ref: 'Team', default: null },
    currentAssignment: { type: ObjectId, ref: 'AssetAssignment', default: null },

    warranty: {
      startDate: { type: Date, default: null },
      expiryDate: { type: Date, default: null },
    },
    maintenance: {
      intervalDays: { type: Number, default: null, min: 1 },
      lastDate: { type: Date, default: null },
      nextDate: { type: Date, default: null },
    },
    license: { type: licenseSchema, default: null },

    notes: { type: String, default: '', trim: true, maxlength: 5000 },
    imageDocument: { type: ObjectId, ref: 'Document', default: null },
    statusHistory: { type: [statusEntrySchema], default: [] },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User', default: null },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    updatedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Identifiers are unique within an ORGANIZATION (two companies may both own "LAP-001").
assetSchema.index({ organization: 1, assetId: 1 }, { unique: true });
assetSchema.index({ organization: 1, assetTag: 1 }, { unique: true, partialFilterExpression: { assetTag: { $type: 'string' } } });
assetSchema.index({ organization: 1, serialNumber: 1 }, { unique: true, partialFilterExpression: { serialNumber: { $type: 'string' } } });
assetSchema.index({ organization: 1, deletedAt: 1, status: 1 });
assetSchema.index({ organization: 1, deletedAt: 1, category: 1 });
assetSchema.index({ organization: 1, assignedUser: 1 });
assetSchema.index({ organization: 1, assignedTeam: 1 });
assetSchema.index({ organization: 1, team: 1 });
assetSchema.index({ organization: 1, 'warranty.expiryDate': 1 });
assetSchema.index({ organization: 1, 'license.expiryDate': 1 });
assetSchema.index({ organization: 1, 'maintenance.nextDate': 1 });
assetSchema.index({ organization: 1, name: 1 });

assetSchema.methods.toSafeObject = function toSafeObject({ canSeeLicenseKey = false } = {}) {
  const raw = this.toObject({ virtuals: false });
  const license = raw.license
    ? {
        ...raw.license,
        keyReference: canSeeLicenseKey ? raw.license.keyReference : undefined,
        hasKeyReference: Boolean(raw.license.keyReference),
        availableSeats: Math.max(0, raw.license.seats - raw.license.allocatedSeats),
      }
    : null;
  const { _id, __v, statusHistory, ...rest } = raw;
  return {
    ...rest,
    id: _id.toString(),
    license,
    statusHistory: (statusHistory || []).slice(-20).reverse(),
  };
};

module.exports = mongoose.model('Asset', assetSchema);
