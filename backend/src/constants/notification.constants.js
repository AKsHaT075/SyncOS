const env = require('../config/env');

const NOTIFICATION_CATEGORIES = Object.freeze({
  TASK: 'task',
  PROJECT: 'project',
  MEETING: 'meeting',
  TEAM: 'team', // people & teams
  DOCUMENT: 'document',
  CALENDAR: 'calendar',
  SECURITY: 'security', // never user-configurable
});

// What users can toggle in their preferences. Security is deliberately absent.
const CONFIGURABLE_CATEGORIES = Object.freeze(
  Object.values(NOTIFICATION_CATEGORIES).filter((category) => category !== NOTIFICATION_CATEGORIES.SECURITY),
);

const NOTIFICATION_TARGETS = Object.freeze({
  TASK: 'task',
  PROJECT: 'project',
  MEETING: 'meeting',
  MEETING_REQUEST: 'meeting_request',
  DOCUMENT: 'document',
  TEAM: 'team',
  CALENDAR_EVENT: 'calendar_event',
});

const EMAIL_STATUS = Object.freeze({
  NONE: 'none', // not requested (type ineligible or user opted out)
  PENDING: 'pending', // persisted, not yet handed to the queue
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed', // retries exhausted (dead-lettered)
});

/**
 * Retention: every notification — unread, read or dismissed — expires
 * `RETENTION_DAYS` after creation. One TTL index on `createdAt` enforces it
 * uniformly (read state never extends or shortens a notification's life).
 * Mongo's TTL monitor runs about once a minute, so deletion can lag; reads
 * therefore also filter by the same cutoff and never surface an expired row.
 */
const RETENTION_DAYS = env.NOTIFICATION_RETENTION_DAYS;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

const MAX_CONNECTIONS_PER_USER = 5;
const HEARTBEAT_MS = 25 * 1000;
const UNREAD_COUNT_CAP = 100; // UI shows "99+"
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

const REMINDER_LEAD_MS = 15 * 60 * 1000;

module.exports = {
  CONFIGURABLE_CATEGORIES,
  DEFAULT_PAGE_SIZE,
  EMAIL_STATUS,
  HEARTBEAT_MS,
  MAX_CONNECTIONS_PER_USER,
  MAX_PAGE_SIZE,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TARGETS,
  REMINDER_LEAD_MS,
  RETENTION_DAYS,
  RETENTION_MS,
  UNREAD_COUNT_CAP,
};
