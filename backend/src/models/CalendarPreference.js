const mongoose = require('mongoose');
const { CALENDAR_VIEWS } = require('../constants/calendar.constants');

/**
 * Per (user, organization), like NotificationPreference. `timezone: null`
 * means "use the organization default, then UTC".
 */
const calendarPreferenceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    timezone: { type: String, default: null },
    weekStartsOn: { type: Number, enum: [0, 1, 6], default: 1 },
    defaultView: { type: String, enum: CALENDAR_VIEWS, default: 'month' },
    // Legend toggles the user switched off (e.g. 'task', 'meeting', 'personal').
    hiddenCategories: { type: [String], default: [] },
  },
  { timestamps: true },
);

calendarPreferenceSchema.index({ user: 1, organization: 1 }, { unique: true });

module.exports = mongoose.model('CalendarPreference', calendarPreferenceSchema);
