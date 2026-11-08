const mongoose = require('mongoose');

/** Per-organization sequence behind asset IDs (AST-000001…), incremented atomically. */
const counterSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true },
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model('AssetCounter', counterSchema);
