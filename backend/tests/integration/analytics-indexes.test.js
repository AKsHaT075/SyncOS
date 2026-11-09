const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const AuditLog = require('../../src/models/AuditLog');
const Meeting = require('../../src/models/Meeting');
const Task = require('../../src/models/Task');
const User = require('../../src/models/User');
const Organization = require('../../src/models/Organization');
const { OPEN_TASK_STATUSES } = require('../../src/constants/analytics.constants');

const org = new mongoose.Types.ObjectId();
const from = new Date('2026-01-01');
const to = new Date('2026-02-01');

/** Walks the explain output and returns every plan stage name. */
const stages = (plan, found = []) => {
  if (!plan || typeof plan !== 'object') return found;
  if (plan.stage) found.push(plan.stage);
  Object.values(plan).forEach((value) => (Array.isArray(value) ? value.forEach((item) => stages(item, found)) : stages(value, found)));
  return found;
};

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([Task, Meeting, AuditLog, User, Organization].map((model) => model.init()));
});
afterAll(disconnectTestDb);

describe('analytics queries are index-backed (no collection scans)', () => {
  const noScan = async (query) => {
    const plan = (await query.explain('queryPlanner')).queryPlanner.winningPlan;
    expect(stages(plan)).not.toContain('COLLSCAN');
    expect(stages(plan)).toContain('IXSCAN');
  };

  it.each([
    ['tasks by organization and status/due date', () => Task.find({ organization: org, deletedAt: null, status: { $in: OPEN_TASK_STATUSES }, dueDate: { $lt: to } })],
    ['tasks completed in a range', () => Task.find({ organization: org, completedAt: { $gte: from, $lt: to } })],
    ['tasks created in a range', () => Task.find({ organization: org, createdAt: { $gte: from, $lt: to } })],
    ['tasks per assignee', () => Task.find({ organization: org, assignees: { $in: [new mongoose.Types.ObjectId()] }, status: 'Todo' })],
    ['meetings in a range', () => Meeting.find({ organization: org, startTime: { $gte: from, $lt: to } })],
    ['audit events by action and time', () => AuditLog.find({ organization: org, action: 'project.status_changed', createdAt: { $gte: from, $lt: to } })],
    ['platform login activity', () => AuditLog.find({ action: 'auth.login_succeeded', createdAt: { $gte: from, $lt: to } })],
    ['member growth', () => User.find({ organization: org, createdAt: { $gte: from, $lt: to } })],
    ['organization growth', () => Organization.find({ createdAt: { $gte: from, $lt: to } })],
  ])('%s', async (_name, build) => noScan(build()));
});
