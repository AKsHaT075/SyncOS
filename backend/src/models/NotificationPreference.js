const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema(
  { inApp: { type: Boolean, default: true }, email: { type: Boolean, default: true } },
  { _id: false },
);

/**
 * Preferences are per (user, organization): a person who later belongs to
 * several organizations can tune each independently. Missing rows mean
 * "defaults", so nothing needs backfilling when categories are added.
 * There is intentionally no `security` category — it cannot be switched off.
 */
const notificationPreferenceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    channels: { type: channelSchema, default: () => ({}) },
    categories: {
      task: { type: channelSchema, default: () => ({}) },
      project: { type: channelSchema, default: () => ({}) },
      meeting: { type: channelSchema, default: () => ({}) },
      team: { type: channelSchema, default: () => ({}) },
      document: { type: channelSchema, default: () => ({}) },
      calendar: { type: channelSchema, default: () => ({}) },
    },
  },
  { timestamps: true },
);

notificationPreferenceSchema.index({ user: 1, organization: 1 }, { unique: true });

module.exports = mongoose.model('NotificationPreference', notificationPreferenceSchema);
