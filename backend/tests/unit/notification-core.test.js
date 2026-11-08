const { NOTIFICATION_TYPES, ACCOUNT_EMAIL_TYPES } = require('../../src/constants/notificationTypes');
const { CONFIGURABLE_CATEGORIES, NOTIFICATION_CATEGORIES } = require('../../src/constants/notification.constants');
const { buildDedupeKey, mergePreferences, resolveChannels } = require('../../src/services/notification.service');
const { updatePreferencesSchema, listNotificationsQuerySchema } = require('../../src/validations/notification.validation');
const { buildLink } = require('../../src/services/notificationAccess.service');
const {
  buildAccountEmail, buildMeetingInvitationEmail, buildNotificationEmail,
} = require('../../src/utils/emailTemplates');

describe('catalogue', () => {
  it('has generic titles: resource names only ever appear in the message', () => {
    Object.entries(NOTIFICATION_TYPES).forEach(([type, def]) => {
      expect(def.title).not.toMatch(/[“”"]/);
      const message = def.message({ actor: 'Ann', p: { task: 'SECRET', project: 'SECRET', topic: 'SECRET', document: 'SECRET', team: 'SECRET', role: 'r', status: 's', permission: 'p', minutes: 5, newOwner: 'N' } });
      expect(typeof message).toBe('string');
      expect(def.title).not.toContain('SECRET');
      expect(['task', 'project', 'meeting', 'team', 'document', 'calendar', 'asset', 'security']).toContain(def.category);
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/);
    });
  });

  it('email-eligible types are a deliberately small, high-signal set', () => {
    const emailTypes = Object.entries(NOTIFICATION_TYPES).filter(([, def]) => def.email).map(([type]) => type).sort();
    expect(emailTypes).toEqual([
      'asset.assigned', 'asset.license_expiring', 'asset.return_requested', 'asset.warranty_expiring',
      'calendar.event_cancelled', 'calendar.event_invited', 'calendar.reminder',
      'document.shared', 'meeting.cancelled', 'meeting.invited', 'meeting_request.approved',
      'meeting_request.rejected', 'person.role_changed', 'security.access_restored',
      'task.assigned', 'task.changes_requested', 'task.rejected',
    ]);
  });

  it('never links to resources the user just lost access to', () => {
    ['task.unassigned', 'project.member_removed', 'project.deleted', 'meeting.removed', 'team.member_removed',
      'team.manager_removed', 'document.access_revoked'].forEach((type) => {
      expect(NOTIFICATION_TYPES[type].link).toBe(false);
    });
  });

  it('account emails (blocked / removed) reveal only the organization name', () => {
    Object.values(ACCOUNT_EMAIL_TYPES).forEach((build) => {
      const { heading, body } = build({ org: 'Acme' });
      const mail = buildAccountEmail({ heading, body, firstName: 'Bo' });
      expect(`${mail.subject} ${mail.text} ${mail.html}`).toContain('Acme');
      expect(`${mail.text}`).not.toMatch(/project|task|meeting|document|team/i);
    });
  });
});

describe('resolveChannels', () => {
  const task = NOTIFICATION_TYPES['task.assigned'];
  const status = NOTIFICATION_TYPES['task.status_changed'];

  it('uses sensible defaults: in-app on; email only for email-eligible types', () => {
    expect(resolveChannels(task, null)).toEqual({ inApp: true, email: true });
    expect(resolveChannels(status, null)).toEqual({ inApp: true, email: false });
  });

  it('honours the global channel switches', () => {
    expect(resolveChannels(task, { channels: { inApp: false } })).toEqual({ inApp: false, email: true });
    expect(resolveChannels(task, { channels: { email: false } })).toEqual({ inApp: true, email: false });
  });

  it('honours per-category switches independently', () => {
    const prefs = { categories: { task: { inApp: false }, meeting: { email: false } } };
    expect(resolveChannels(task, prefs)).toEqual({ inApp: false, email: true });
    expect(resolveChannels(NOTIFICATION_TYPES['meeting.invited'], prefs)).toEqual({ inApp: true, email: false });
    expect(resolveChannels(NOTIFICATION_TYPES['document.shared'], prefs)).toEqual({ inApp: true, email: true });
  });

  it('event reminders are emailed only when the reminder asked for it (and the user allows calendar email)', () => {
    const reminder = NOTIFICATION_TYPES['calendar.reminder'];
    expect(resolveChannels(reminder, null)).toEqual({ inApp: true, email: false });
    expect(resolveChannels(reminder, null, { emailRequested: true })).toEqual({ inApp: true, email: true });
    expect(resolveChannels(reminder, { categories: { calendar: { email: false } } }, { emailRequested: true })).toEqual({ inApp: true, email: false });
    expect(resolveChannels(reminder, { channels: { email: false } }, { emailRequested: true }).email).toBe(false);
  });

  it('security notifications ignore every preference', () => {
    const off = { channels: { inApp: false, email: false }, categories: Object.fromEntries(CONFIGURABLE_CATEGORIES.map((c) => [c, { inApp: false, email: false }])) };
    expect(resolveChannels(NOTIFICATION_TYPES['security.access_restored'], off)).toEqual({ inApp: true, email: true });
    expect(resolveChannels(NOTIFICATION_TYPES['security.password_reset_forced'], off)).toEqual({ inApp: true, email: false });
  });

  it('mergePreferences fills missing keys and has no security category', () => {
    const merged = mergePreferences({ categories: { task: { email: false } } });
    expect(merged.categories.task).toEqual({ inApp: true, email: false });
    expect(Object.keys(merged.categories).sort()).toEqual([...CONFIGURABLE_CATEGORIES].sort());
    expect(merged.categories).not.toHaveProperty(NOTIFICATION_CATEGORIES.SECURITY);
  });
});

describe('buildDedupeKey', () => {
  it('is deterministic and recipient-specific', () => {
    const base = { type: 'task.assigned', resourceId: 't1', occurrence: 5 };
    expect(buildDedupeKey({ ...base, recipientId: 'u1' })).toBe(buildDedupeKey({ ...base, recipientId: 'u1' }));
    expect(buildDedupeKey({ ...base, recipientId: 'u1' })).not.toBe(buildDedupeKey({ ...base, recipientId: 'u2' }));
  });

  it('distinguishes genuinely new occurrences of the same event', () => {
    const base = { type: 'task.assigned', resourceId: 't1', recipientId: 'u1' };
    expect(buildDedupeKey({ ...base, occurrence: 1 })).not.toBe(buildDedupeKey({ ...base, occurrence: 2 }));
  });

  it('refuses to build a key without an occurrence (it would suppress real events)', () => {
    expect(() => buildDedupeKey({ type: 't', resourceId: 'r', recipientId: 'u' })).toThrow(/occurrence/);
    expect(() => buildDedupeKey({ type: 't', resourceId: 'r', recipientId: 'u', occurrence: '' })).toThrow();
    expect(buildDedupeKey({ type: 't', resourceId: 'r', recipientId: 'u', occurrence: 0 })).toContain(':0');
  });
});

describe('validation', () => {
  it('preferences cannot touch the security category or unknown keys', () => {
    expect(updatePreferencesSchema.safeParse({ categories: { security: { email: false } } }).success).toBe(false);
    expect(updatePreferencesSchema.safeParse({ categories: { task: { sms: true } } }).success).toBe(false);
    expect(updatePreferencesSchema.safeParse({ organization: 'x', channels: { email: false } }).success).toBe(false);
    expect(updatePreferencesSchema.safeParse({}).success).toBe(false);
    expect(updatePreferencesSchema.safeParse({ categories: { task: {} } }).success).toBe(false);
    expect(updatePreferencesSchema.safeParse({ channels: { email: false } }).success).toBe(true);
    expect(updatePreferencesSchema.safeParse({ categories: { task: { inApp: false } } }).success).toBe(true);
  });

  it('list query is strict and bounded', () => {
    expect(listNotificationsQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ recipient: 'x' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ status: 'archived' }).success).toBe(false);
    expect(listNotificationsQuerySchema.parse({}).limit).toBe(20);
  });
});

describe('links and emails', () => {
  it('builds destination links from target data only', () => {
    expect(buildLink({ type: 'task', id: 't1', project: 'p1' })).toBe('/dashboard/projects/p1/tasks/t1');
    expect(buildLink({ type: 'meeting', id: 'm1', project: 'p1' })).toBe('/dashboard/projects/p1/meetings/m1');
    expect(buildLink({ type: 'document', id: 'd1' })).toBe('/dashboard/documents?doc=d1');
    expect(buildLink({ type: 'task', id: 't1' })).toBeNull(); // needs its project
    expect(buildLink(null)).toBeNull();
  });

  it('escapes HTML in generated emails', () => {
    const mail = buildNotificationEmail({ title: 'T', message: '<script>alert(1)</script>', url: 'http://x/"onload=', firstName: '<b>' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('"onload=');
    expect(buildMeetingInvitationEmail({ meetingTopic: '<i>x</i>', projectName: 'P', joinUrl: 'u' }).html).not.toContain('<i>');
  });
});
