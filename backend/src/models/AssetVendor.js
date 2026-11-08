const mongoose = require('mongoose');

/** Lightweight supplier directory — contact details only (no purchasing, invoicing or payables). */
const vendorSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    contactPerson: { type: String, default: '', trim: true, maxlength: 100 },
    email: { type: String, default: '', trim: true, lowercase: true, maxlength: 150 },
    phone: { type: String, default: '', trim: true, maxlength: 40 },
    address: { type: String, default: '', trim: true, maxlength: 400 },
    website: { type: String, default: '', trim: true, maxlength: 200 },
    notes: { type: String, default: '', trim: true, maxlength: 1000 },
    archivedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

vendorSchema.index({ organization: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('AssetVendor', vendorSchema);
