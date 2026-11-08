const env = require('../config/env');
const { createRedisClient } = require('../config/redis');
const { MEETING_STATUS } = require('../constants/meeting.constants');
const { REMINDER_LEAD_MS } = require('../constants/notification.constants');
const Meeting = require('../models/Meeting');
const Project = require('../models/Project');
const { meetingReminder } = require('./notificationEvents');
const { sweepPendingEmails } = require('./notificationEmail.service');
const { runCalendarReminders } = require('./calendarReminders');

const TICK_MS = 60 * 1000;

async function withLock(name, ttlSeconds, fn) {
  try {
    const client = createRedisClient();
    if (client.isOpen) {
      const acquired = await client.set(`${env.NOTIFICATION_CHANNEL_PREFIX}:lock:${name}`, '1', { NX: true, EX: ttlSeconds });
      if (!acquired) return null; // another instance is already doing this tick
    }
  } catch {
    /* no Redis: run anyway — every job below is idempotent */
  }
  return fn();
}

/**
 * Sends "starting soon" reminders for scheduled meetings starting within the
 * lead window. Safe to run as often as you like and from several instances:
 * the notification's dedupe key is (meeting, start time), so each participant
 * gets one reminder per scheduled start — and a rescheduled meeting (new
 * start time) correctly gets a fresh one.
 */
async function runMeetingReminders({ now = Date.now() } = {}) {
  const meetings = await Meeting.find({
    status: MEETING_STATUS.SCHEDULED,
    deletedAt: null,
    startTime: { $gte: new Date(now), $lte: new Date(now + REMINDER_LEAD_MS) },
  })
    .limit(200)
    .lean();
  if (meetings.length === 0) return { meetings: 0 };

  const projects = await Project.find({ _id: { $in: meetings.map((m) => m.project) }, deletedAt: null })
    .select('name organization')
    .lean();
  const byId = new Map(projects.map((project) => [project._id.toString(), project]));

  for (const meeting of meetings) {
    const project = byId.get(meeting.project.toString());
    // eslint-disable-next-line no-await-in-loop
    if (project) await meetingReminder({ meeting, project, now });
  }
  return { meetings: meetings.length };
}

function startNotificationJobs() {
  const tick = () => {
    withLock('reminders', 50, runMeetingReminders).catch((error) => console.error('[notifications] reminders failed:', error.message));
    withLock('calendar-reminders', 50, runCalendarReminders).catch((error) => console.error('[notifications] calendar reminders failed:', error.message));
    withLock('email-sweep', 50, sweepPendingEmails).catch((error) => console.error('[notifications] email sweep failed:', error.message));
  };
  tick();
  const interval = setInterval(tick, TICK_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

module.exports = { runCalendarReminders, runMeetingReminders, startNotificationJobs };
