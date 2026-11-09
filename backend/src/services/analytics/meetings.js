const mongoose = require('mongoose');
const { MEETING_STATUS } = require('../../constants/meeting.constants');
const { ANALYTICS_LIMITS, SCOPE_KIND } = require('../../constants/analytics.constants');
const AuditLog = require('../../models/AuditLog');
const Meeting = require('../../models/Meeting');
const { bucketExpr, denseSeries } = require('../../utils/analyticsRange');
const { idOf, percent, personNames, requireKind, run, table } = require('./common');

const DAY_MS = 86400000;

/** Meetings the actor may see: everything (admin / HR counts), visible projects + their people (manager), or their own. */
function meetingMatch(scope, range, filters = {}) {
  const clauses = [{ organization: scope.organization, startTime: { $gte: range.start, $lt: range.end } }];
  if (scope.kind === SCOPE_KIND.SELF) clauses.push({ $or: [{ host: scope.actor._id }, { 'participants.user': scope.actor._id }] });
  if (scope.kind === SCOPE_KIND.TEAM) {
    clauses.push({ project: { $in: scope.visibleProjectIds } });
    clauses.push({ $or: [{ host: { $in: scope.personIds } }, { 'participants.user': { $in: scope.personIds } }] });
  }
  if (filters.projectId) clauses.push({ project: new mongoose.Types.ObjectId(filters.projectId) });
  if (filters.personIds && scope.kind !== SCOPE_KIND.SELF) clauses.push({ $or: [{ host: { $in: filters.personIds } }, { 'participants.user': { $in: filters.personIds } }] });
  return { $and: clauses };
}

/**
 * Real meeting length comes from the audit trail (first join → end). The model only has a PLANNED end time, so
 * actual duration is reported only for meetings that have both events, with the sample size.
 */
async function actualDurations(meetingIds, organization) {
  if (!meetingIds.length) return { avgMinutes: null, sample: 0 };
  const ids = meetingIds.slice(0, 500).map(idOf);
  const events = await AuditLog.find({ organization, entityType: 'meeting', entityId: { $in: ids }, action: { $in: ['meeting.started', 'meeting.ended'] } })
    .select('action entityId createdAt').sort({ createdAt: 1 }).lean();
  const started = new Map();
  const ended = new Map();
  events.forEach((event) => {
    if (event.action === 'meeting.started' && !started.has(event.entityId)) started.set(event.entityId, event.createdAt.getTime());
    if (event.action === 'meeting.ended') ended.set(event.entityId, event.createdAt.getTime());
  });
  const lengths = [...started.entries()].filter(([id]) => ended.has(id) && ended.get(id) >= started.get(id)).map(([id, start]) => ended.get(id) - start);
  return { avgMinutes: lengths.length ? Number((lengths.reduce((a, b) => a + b, 0) / lengths.length / 60000).toFixed(0)) : null, sample: lengths.length };
}

async function computeMeetings(scope, range, filters = {}) {
  requireKind(scope, [SCOPE_KIND.ORGANIZATION, SCOPE_KIND.AGGREGATE, SCOPE_KIND.TEAM, SCOPE_KIND.SELF]);
  const match = { $match: meetingMatch(scope, range, filters) };
  // Participation counts only the people in scope (so a manager's numbers describe their people).
  const scoped = scope.kind === SCOPE_KIND.TEAM || scope.kind === SCOPE_KIND.SELF || Boolean(filters.personIds);
  const people = filters.personIds || scope.personIds;

  const [byStatus, byType, series, participation, planned, ended] = await Promise.all([
    run(Meeting, [match, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    run(Meeting, [match, { $group: { _id: '$type', count: { $sum: 1 } } }]),
    run(Meeting, [match, { $group: { _id: bucketExpr('$startTime', range), meetings: { $sum: 1 } } }]),
    run(Meeting, [match, { $unwind: '$participants' }, ...(scoped ? [{ $match: { 'participants.user': { $in: people } } }] : []),
      { $group: { _id: null, invited: { $sum: 1 }, accepted: { $sum: { $cond: [{ $eq: ['$participants.status', 'Accepted'] }, 1, 0] } },
        declined: { $sum: { $cond: [{ $eq: ['$participants.status', 'Declined'] }, 1, 0] } }, attended: { $sum: { $cond: [{ $ne: ['$participants.joinedAt', null] }, 1, 0] } } } }]),
    run(Meeting, [match, { $match: { endTime: { $ne: null } } }, { $group: { _id: null, avgMs: { $avg: { $subtract: ['$endTime', '$startTime'] } }, n: { $sum: 1 } } }]),
    Meeting.find(meetingMatch(scope, range, filters)).where({ status: MEETING_STATUS.ENDED }).select('_id').limit(500).lean(),
  ]);

  const count = (status) => byStatus.find((row) => row._id === status)?.count || 0;
  const total = byStatus.reduce((acc, row) => acc + row.count, 0);
  const p = participation[0] || { invited: 0, accepted: 0, declined: 0, attended: 0 };
  const actual = await actualDurations(ended.map((meeting) => meeting._id), scope.organization);

  const result = {
    kpis: {
      total, scheduled: count(MEETING_STATUS.SCHEDULED), active: count(MEETING_STATUS.ACTIVE), ended: count(MEETING_STATUS.ENDED), cancelled: count(MEETING_STATUS.CANCELLED),
      invitations: p.invited, accepted: p.accepted, declined: p.declined, attended: p.attended,
      attendanceRate: percent(p.attended, p.invited), responseRate: percent(p.accepted + p.declined, p.invited),
      avgPlannedMinutes: planned[0] ? Math.round(planned[0].avgMs / 60000) : null,
      avgActualMinutes: actual.avgMinutes, avgActualSample: actual.sample,
    },
    series: { meetingsOverTime: denseSeries(series, range, ['meetings']) },
    breakdowns: {
      byStatus: Object.values(MEETING_STATUS).map((status) => ({ key: status, count: count(status) })),
      byType: byType.map((row) => ({ key: row._id, count: row.count })),
    },
    notes: [
      'Planned length is the scheduled end time minus the start time. Actual length is measured only for meetings with both a start and an end record, and the sample size is shown.',
      'Attended means the person joined the meeting room; invitations that were never answered count as invited only.',
    ],
  };

  if (!scope.details || scope.kind === SCOPE_KIND.SELF) {
    result.table = null; // HR sees counts only; a personal view has no organization table
    return result;
  }
  const rows = await Meeting.find(meetingMatch(scope, range, filters)).sort({ startTime: -1 }).limit(ANALYTICS_LIMITS.TABLE_ROWS_MAX).select('topic startTime status type host participants').lean();
  const hosts = await personNames(rows.map((meeting) => meeting.host), scope.organization);
  result.table = table(
    [{ key: 'topic', label: 'Meeting' }, { key: 'start', label: 'Starts', type: 'datetime' }, { key: 'status', label: 'Status' }, { key: 'type', label: 'Type' }, { key: 'host', label: 'Host' },
      { key: 'participants', label: 'Invited', type: 'number' }, { key: 'attended', label: 'Joined', type: 'number' }],
    rows.map((meeting) => ({
      topic: meeting.topic, start: meeting.startTime.toISOString(), status: meeting.status, type: meeting.type, host: hosts.get(idOf(meeting.host)) || '',
      participants: meeting.participants.length, attended: meeting.participants.filter((participant) => participant.joinedAt).length,
    })),
  );
  return result;
}

module.exports = { computeMeetings, meetingMatch };
