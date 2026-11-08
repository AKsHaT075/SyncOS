const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { ROLES } = require('../constants/roles');
const User = require('../models/User');
const Team = require('../models/Team');
const Project = require('../models/Project');
const { logAudit } = require('./audit.service');
const notificationEvents = require('./notificationEvents');
const { TEAM_ADMIN_ROLES, canManageTeamMembers, canViewTeam, getTeamStanding } = require('../utils/teamAccess');

/**
 * Team service.
 *
 * The roster stored on the Team document (members + lead) is the single
 * source of truth for membership. User.team mirrors that roster as the
 * user's primary team, and the two are only ever updated together (see
 * moveUserToTeam / removeUserFromAllTeams) so they cannot drift apart.
 *
 * Moving a user to a team always removes them from any other team's
 * roster (one primary team per user). A user who manages another team
 * must be reassigned first — the move is rejected with LEAD_OF_OTHER_TEAM
 * rather than silently demoting them somewhere else.
 */

const MEMBER_POPULATE = 'firstName lastName email role team skills';
const LEAD_POPULATE = 'firstName lastName email role';

function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeLead(lead) {
  if (!lead) return null;
  return {
    id: idOf(lead),
    firstName: lead.firstName ?? null,
    lastName: lead.lastName ?? null,
    fullName: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    email: lead.email ?? null,
    role: lead.role ?? null,
  };
}

function serializeMember(member) {
  return {
    id: idOf(member),
    firstName: member.firstName ?? null,
    lastName: member.lastName ?? null,
    fullName: [member.firstName, member.lastName].filter(Boolean).join(' '),
    email: member.email ?? null,
    role: member.role ?? null,
    skills: Array.isArray(member.skills) ? member.skills : [],
    team: idOf(member.team),
  };
}

function serializeTeam(team, actor, { includeMembers = false } = {}) {
  const result = {
    id: team._id.toString(),
    name: team.name,
    description: team.description ?? null,
    lead: serializeLead(team.lead),
    memberCount: team.members.length,
    myStanding: getTeamStanding(actor, team),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
  if (includeMembers) {
    result.members = team.members.map(serializeMember);
  }
  return result;
}

async function findTeam(teamId, organization) {
  if (!mongoose.isValidObjectId(teamId)) {
    throw new AppError('Team not found', 404, 'NOT_FOUND');
  }
  const team = await Team.findOne({ _id: teamId, organization });
  if (!team) {
    throw new AppError('Team not found', 404, 'NOT_FOUND');
  }
  return team;
}

async function findTeamView(teamId, organization) {
  const team = await findTeam(teamId, organization);
  await team.populate('lead', LEAD_POPULATE);
  await team.populate('members', MEMBER_POPULATE);
  return team;
}

async function assertUserInOrganization(userId, organization, label) {
  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError(`${label} not found`, 404, 'NOT_FOUND');
  }
  const user = await User.findById(userId);
  if (!user || idOf(user.organization) !== idOf(organization)) {
    throw new AppError(`${label} not found`, 404, 'NOT_FOUND');
  }
  return user;
}

async function assertTeamNameAvailable(organization, name, excludeId = null) {
  const query = { organization, name: new RegExp(`^${escapeRegex(name)}$`, 'i') };
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await Team.findOne(query);
  if (existing) {
    throw new AppError('A team with this name already exists', 409, 'TEAM_NAME_TAKEN');
  }
}

async function listTeams({
  actor,
  search,
  page = 1,
  limit = 20,
  sortBy = 'createdAt',
  sortOrder = 'desc',
}) {
  const query = { organization: actor.organization };
  if (!TEAM_ADMIN_ROLES.includes(actor.role)) {
    query.$or = [{ members: actor._id }, { lead: actor._id }];
  }
  if (search) {
    query.name = new RegExp(escapeRegex(search), 'i');
  }
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
  const skip = (page - 1) * limit;

  const [teams, total] = await Promise.all([
    Team.find(query).sort(sort).skip(skip).limit(limit).populate('lead', LEAD_POPULATE),
    Team.countDocuments(query),
  ]);

  return {
    teams: teams.map((team) => serializeTeam(team, actor)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function getTeam({ teamId, actor }) {
  const team = await findTeamView(teamId, actor.organization);
  assertCanView(actor, team);
  return serializeTeam(team, actor, { includeMembers: true });
}

async function getMyTeam({ actor }) {
  if (!actor.team) {
    return { team: null };
  }
  const team = await Team.findOne({ _id: actor.team, organization: actor.organization })
    .populate('lead', LEAD_POPULATE)
    .populate('members', MEMBER_POPULATE);
  if (!team) {
    return { team: null };
  }
  return { team: serializeTeam(team, actor, { includeMembers: true }) };
}

async function listMemberCandidates({ teamId, actor, search, role }) {
  const team = await findTeam(teamId, actor.organization);
  assertCanManageMembers(actor, team);

  const memberIds = team.members.map(idOf);
  if (team.lead) memberIds.push(idOf(team.lead));

  const leadsOfOtherTeams = await Team.find({
    organization: actor.organization,
    _id: { $ne: team._id },
    lead: { $ne: null },
  }).select('lead');
  const excludedIds = [...new Set([...memberIds, ...leadsOfOtherTeams.map((leadTeam) => idOf(leadTeam.lead))])];

  const query = { organization: actor.organization, isActive: true, _id: { $nin: excludedIds } };
  if (role) query.role = role;
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ firstName: regex }, { lastName: regex }, { email: regex }];
  }

  const users = await User.find(query)
    .select('firstName lastName email role')
    .sort({ firstName: 1, lastName: 1 })
    .limit(20);

  return {
    candidates: users.map((user) => ({
      id: user._id.toString(),
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
      email: user.email,
      role: user.role,
    })),
  };
}

/**
 * Shared membership seams.
 *
 * These keep the Team roster and User.team consistent no matter which
 * caller triggers the move (team member add, manager assignment, or a
 * people-directory team change). They are org-scoped but intentionally do
 * not gate permissions — every call site gates with its own permission
 * check (MANAGE_TEAM_MEMBERS for team routes, MANAGE_USERS + canManageUsers
 * for the people directory).
 */

async function assertNotLeadOfOtherTeam(user, exceptTeamId) {
  const ledTeam = await Team.findOne({
    organization: user.organization,
    lead: user._id,
    _id: { $ne: exceptTeamId },
  });
  if (ledTeam) {
    throw new AppError(
      'This user manages another team. Reassign that team manager first.',
      409,
      'LEAD_OF_OTHER_TEAM',
    );
  }
}

async function removeUserFromRosters(user, { exceptTeamId = null } = {}) {
  const teams = await Team.find({
    organization: user.organization,
    _id: { $ne: exceptTeamId },
    $or: [{ members: user._id }, { lead: user._id }],
  });

  const removedFrom = [];
  for (const team of teams) {
    const wasLead = idOf(team.lead) === idOf(user._id);
    team.members = team.members.filter((member) => idOf(member) !== idOf(user._id));
    if (wasLead) team.lead = null;
    await team.save();
    removedFrom.push({ teamId: team._id.toString(), wasLead });
    // Non-enumerable so it never leaks into audit metadata / API payloads.
    Object.defineProperty(removedFrom[removedFrom.length - 1], 'team', { value: team, enumerable: false });
  }
  return removedFrom;
}

async function notifyRemovedFrom(removedFrom, { user, actor }) {
  for (const entry of removedFrom) {
    // eslint-disable-next-line no-await-in-loop
    await notificationEvents.teamMemberRemoved({ team: entry.team, actor, userId: user._id });
  }
}

async function moveUserToTeam({ user, teamId, actor, req }) {
  const team = await findTeam(teamId, actor.organization);
  await assertNotLeadOfOtherTeam(user, team._id);

  const fromTeam = idOf(user.team);
  const removedFrom = await removeUserFromRosters(user, { exceptTeamId: team._id });
  if (!team.members.some((member) => idOf(member) === idOf(user._id))) {
    team.members.push(user._id);
  }
  user.team = team._id;
  await Promise.all([team.save(), user.save()]);

  if (fromTeam !== team._id.toString()) {
    await notificationEvents.teamMemberAdded({ team, actor, userId: user._id });
    await notifyRemovedFrom(removedFrom, { user, actor });

    await logAudit({
      action: AUDIT_EVENTS.PERSON_TEAM_CHANGED,
      entityType: 'person',
      entityId: idOf(user._id),
      metadata: { fromTeam, toTeam: team._id.toString(), removedFrom },
      organizationId: actor.organization,
      userId: idOf(actor._id),
      req,
    });
  }
  return { fromTeam, toTeam: team._id.toString(), removedFrom };
}

async function removeUserFromAllTeams({ user, actor, req, silent = false }) {
  const fromTeam = idOf(user.team);
  const removedFrom = await removeUserFromRosters(user);
  user.team = null;
  await user.save();
  // `silent` is used when the person is being removed from the whole
  // organization — a per-team notice would be unreadable noise for them.
  if (!silent) await notifyRemovedFrom(removedFrom, { user, actor });

  if (fromTeam) {
    await logAudit({
      action: AUDIT_EVENTS.PERSON_TEAM_CHANGED,
      entityType: 'person',
      entityId: idOf(user._id),
      metadata: { fromTeam, toTeam: null, removedFrom },
      organizationId: actor.organization,
      userId: idOf(actor._id),
      req,
    });
  }
  return { fromTeam, toTeam: null, removedFrom };
}


function assertCanView(actor, team) {
  if (!canViewTeam(actor, team)) {
    throw new AppError('You do not have access to this team', 403, 'FORBIDDEN');
  }
}

function assertCanManageMembers(actor, team) {
  if (!canManageTeamMembers(actor, team)) {
    throw new AppError('You do not have permission to manage this team', 403, 'FORBIDDEN');
  }
}

async function createTeam({ actor, name, description = '', lead = null, req }) {
  const organization = actor.organization;
  await assertTeamNameAvailable(organization, name);

  const team = await Team.create({ organization, name, description, lead: null, members: [] });

  if (lead) {
    const leadUser = await assertUserInOrganization(lead, organization, 'Team manager');
    if (leadUser.role !== ROLES.MANAGER) {
      throw new AppError('Only users with the Manager role can be assigned as team manager', 400, 'INVALID_MANAGER_ROLE');
    }
    await moveUserToTeam({ user: leadUser, teamId: team._id.toString(), actor, req });
    team.lead = leadUser._id;
    await team.save();
  }

  await logAudit({
    action: AUDIT_EVENTS.TEAM_CREATED,
    entityType: 'team',
    entityId: team._id.toString(),
    metadata: { name, lead: lead || null },
    organizationId: organization,
    userId: idOf(actor._id),
    req,
  });

  return getTeam({ teamId: team._id.toString(), actor });
}

async function updateTeam({ teamId, actor, updates, req }) {
  const team = await findTeam(teamId, actor.organization);

  if (updates.name !== undefined) {
    await assertTeamNameAvailable(actor.organization, updates.name, team._id);
    team.name = updates.name;
  }
  if (updates.description !== undefined) {
    team.description = updates.description;
  }
  await team.save();

  await logAudit({
    action: AUDIT_EVENTS.TEAM_UPDATED,
    entityType: 'team',
    entityId: team._id.toString(),
    metadata: { updates },
    organizationId: actor.organization,
    userId: idOf(actor._id),
    req,
  });

  return getTeam({ teamId: team._id.toString(), actor });
}

async function deleteTeam({ teamId, actor, req }) {
  const team = await findTeam(teamId, actor.organization);
  const name = team.name;
  const memberIds = [...new Set([...(team.members || []), team.lead].filter(Boolean).map(idOf))];

  await Team.deleteOne({ _id: team._id });

  if (memberIds.length > 0) {
    await User.updateMany({ _id: { $in: memberIds }, team: team._id }, { $set: { team: null } });
  }
  await Project.updateMany({ organization: actor.organization, team: team._id }, { $set: { team: null } });

  await logAudit({
    action: AUDIT_EVENTS.TEAM_DELETED,
    entityType: 'team',
    entityId: team._id.toString(),
    metadata: { name, memberCount: memberIds.length },
    organizationId: actor.organization,
    userId: idOf(actor._id),
    req,
  });

  return { teamId: team._id.toString(), deleted: true };
}


async function addMember({ teamId, actor, userId, req }) {
  const team = await findTeam(teamId, actor.organization);
  assertCanManageMembers(actor, team);
  const user = await assertUserInOrganization(userId, actor.organization, 'Member');

  if (team.members.some((member) => idOf(member) === idOf(userId))) {
    throw new AppError('This user is already a member of the team', 409, 'ALREADY_MEMBER');
  }

  await moveUserToTeam({ user, teamId, actor, req });

  await logAudit({
    action: AUDIT_EVENTS.TEAM_MEMBER_ADDED,
    entityType: 'team',
    entityId: team._id.toString(),
    metadata: { memberId: idOf(userId) },
    organizationId: actor.organization,
    userId: idOf(actor._id),
    req,
  });

  return getTeam({ teamId: team._id.toString(), actor });
}

async function removeMember({ teamId, actor, userId, req }) {
  const team = await findTeam(teamId, actor.organization);
  assertCanManageMembers(actor, team);

  if (team.lead && idOf(team.lead) === idOf(userId)) {
    throw new AppError(
      'Reassign the team manager before removing them from the team',
      409,
      'LEAD_REASSIGN_REQUIRED',
    );
  }
  if (!team.members.some((member) => idOf(member) === idOf(userId))) {
    throw new AppError('This user is not a member of the team', 409, 'NOT_A_MEMBER');
  }

  team.members = team.members.filter((member) => idOf(member) !== idOf(userId));
  await team.save();

  const user = await User.findById(userId);
  if (user && user.team && idOf(user.team) === team._id.toString()) {
    user.team = null;
    await user.save();
  }

  await logAudit({
    action: AUDIT_EVENTS.TEAM_MEMBER_REMOVED,
    entityType: 'team',
    entityId: team._id.toString(),
    metadata: { memberId: idOf(userId) },
    organizationId: actor.organization,
    userId: idOf(actor._id),
    req,
  });

  await notificationEvents.teamMemberRemoved({ team, actor, userId });

  return getTeam({ teamId: team._id.toString(), actor });
}

async function setManager({ teamId, actor, userId, req }) {
  const team = await findTeam(teamId, actor.organization);
  assertCanManageMembers(actor, team);
  const user = await assertUserInOrganization(userId, actor.organization, 'Team manager');

  if (team.lead && idOf(team.lead) === idOf(userId)) {
    throw new AppError('This user is already the team manager', 409, 'ALREADY_MANAGER');
  }
  if (user.role !== ROLES.MANAGER) {
    throw new AppError('Only users with the Manager role can be assigned as team manager', 400, 'INVALID_MANAGER_ROLE');
  }
  await assertNotLeadOfOtherTeam(user, team._id);

  const previousLeadId = idOf(team.lead);
  team.lead = user._id;
  if (!team.members.some((member) => idOf(member) === idOf(user._id))) {
    team.members.push(user._id);
  }
  await team.save();

  await moveUserToTeam({ user, teamId, actor, req });

  await logAudit({
    action: AUDIT_EVENTS.TEAM_MANAGER_CHANGED,
    entityType: 'team',
    entityId: team._id.toString(),
    metadata: { from: previousLeadId, to: idOf(userId) },
    organizationId: actor.organization,
    userId: idOf(actor._id),
    req,
  });

  await notificationEvents.teamManagerChanged({
    team,
    actor,
    newManagerId: userId,
    previousManagerId: previousLeadId,
  });

  return getTeam({ teamId: team._id.toString(), actor });
}

module.exports = {
  addMember,
  createTeam,
  deleteTeam,
  getMyTeam,
  getTeam,
  listMemberCandidates,
  listTeams,
  moveUserToTeam,
  removeMember,
  removeUserFromAllTeams,
  setManager,
  updateTeam,
};
