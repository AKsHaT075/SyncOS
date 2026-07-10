const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const slugify = require('../utils/slugify');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { ROLES } = require('../constants/roles');
const { PROJECT_STATUS, PROJECT_MEMBER_ROLES, STATUS_TRANSITIONS } = require('../constants/project.constants');
const { buildProjectVisibilityFilter, canManageProject, canViewProject, getProjectMemberRole } = require('../utils/projectAccess');
const canDeleteProject = require('../utils/canDeleteProject');
const Project = require('../models/Project');
const User = require('../models/User');
const Team = require('../models/Team');
const AuditLog = require('../models/AuditLog');
const { logAudit } = require('./audit.service');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertUserInOrganization(userId, organization, label = 'User') {
  const user = await User.findOne({ _id: userId, organization });
  if (!user) {
    throw new AppError(`${label} not found in this organization`, 404, 'NOT_FOUND');
  }
  return user;
}

async function assertTeamInOrganization(teamId, organization) {
  const team = await Team.findOne({ _id: teamId, organization });
  if (!team) {
    throw new AppError('Team not found in this organization', 404, 'NOT_FOUND');
  }
  return team;
}

async function assertNameAvailable(organization, name, excludeId = null) {
  const query = {
    organization,
    name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    deletedAt: null,
  };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const existing = await Project.findOne(query);
  if (existing) {
    throw new AppError('A project with this name already exists', 409, 'PROJECT_NAME_TAKEN');
  }
}

async function generateUniqueSlug(organization, name) {
  const base = slugify(name) || 'project';
  let slug = base;
  let attempt = 0;

  while (await Project.exists({ organization, slug })) {
    attempt += 1;
    slug = `${base}-${attempt + 1}`;
  }

  return slug;
}

async function findActiveProject(projectId, organization) {
  if (!mongoose.isValidObjectId(projectId)) {
    throw new AppError('Project not found', 404, 'NOT_FOUND');
  }

  const project = await Project.findOne({ _id: projectId, organization, deletedAt: null })
    .populate('owner', 'firstName lastName email')
    .populate('members.user', 'firstName lastName email');
  if (!project) {
    throw new AppError('Project not found', 404, 'NOT_FOUND');
  }

  return project;
}

function assertCanView(actor, project) {
  if (!canViewProject(actor, project)) {
    throw new AppError('You do not have access to this project', 403, 'FORBIDDEN');
  }
}

function assertCanManage(actor, project) {
  if (!canManageProject(actor, project)) {
    throw new AppError('You do not have permission to manage this project', 403, 'FORBIDDEN');
  }
}

async function createProject({
  name,
  slug: requestedSlug,
  description,
  type,
  isInternal,
  client,
  budget,
  resourceLink,
  owner,
  team,
  priority,
  visibility,
  startDate,
  dueDate,
  creator,
  req,
}) {
  const organization = creator.organization;
  const ownerId = owner || creator._id;

  await assertUserInOrganization(ownerId, organization, 'Owner');
  if (team) {
    await assertTeamInOrganization(team, organization);
  }

  await assertNameAvailable(organization, name);

  let slug = requestedSlug;
  if (slug) {
    if (await Project.exists({ organization, slug })) {
      throw new AppError('This slug is already taken', 409, 'SLUG_TAKEN');
    }
  } else {
    slug = await generateUniqueSlug(organization, name);
  }

  const project = await Project.create({
    organization,
    owner: ownerId,
    team: team || null,
    name: name.trim(),
    slug,
    description: description || '',
    type: type || undefined,
    isInternal: Boolean(isInternal),
    client: isInternal ? '' : client || '',
    budget: budget ?? null,
    resourceLink: resourceLink || '',
    priority,
    visibility,
    startDate: startDate || null,
    dueDate: dueDate || null,
    members: [{ user: ownerId, role: PROJECT_MEMBER_ROLES.OWNER, joinedAt: new Date() }],
    createdBy: creator._id,
    updatedBy: creator._id,
  });

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_CREATED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { name: project.name, slug: project.slug },
    organizationId: organization,
    req,
    userId: creator._id,
  });

  return project.toSafeObject(creator._id);
}

async function updateProject({ projectId, actor, updates, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  if (updates.name && updates.name !== project.name) {
    await assertNameAvailable(actor.organization, updates.name, project._id);
  }

  if (updates.owner) {
    await assertUserInOrganization(updates.owner, actor.organization, 'Owner');
  }

  if (updates.team) {
    await assertTeamInOrganization(updates.team, actor.organization);
  }

  if (updates.status && updates.status !== project.status) {
    if (project.archived) {
      throw new AppError('Restore the project before changing its status', 400, 'PROJECT_ARCHIVED');
    }

    const allowedNext = STATUS_TRANSITIONS[project.status] || [];
    if (!allowedNext.includes(updates.status)) {
      throw new AppError(
        `Cannot move a project from ${project.status} to ${updates.status}`,
        400,
        'INVALID_STATUS_TRANSITION'
      );
    }
  }

  const statusChanged = updates.status && updates.status !== project.status;
  const priorityChanged = updates.priority && updates.priority !== project.priority;
  const previousStatus = project.status;
  const previousPriority = project.priority;

  Object.assign(project, updates);
  project.updatedBy = actor._id;
  await project.save();

  if (statusChanged) {
    await logAudit({
      action: AUDIT_EVENTS.PROJECT_STATUS_CHANGED,
      entityId: project._id.toString(),
      entityType: 'project',
      metadata: { from: previousStatus, to: project.status },
      organizationId: actor.organization,
      req,
      userId: actor._id,
    });
  }

  if (priorityChanged) {
    await logAudit({
      action: AUDIT_EVENTS.PROJECT_PRIORITY_CHANGED,
      entityId: project._id.toString(),
      entityType: 'project',
      metadata: { from: previousPriority, to: project.priority },
      organizationId: actor.organization,
      req,
      userId: actor._id,
    });
  }

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_UPDATED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { fields: Object.keys(updates) },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return project.toSafeObject(actor._id);
}

async function archiveProject({ projectId, actor, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  if (project.archived) {
    throw new AppError('This project is already archived', 409, 'PROJECT_ALREADY_ARCHIVED');
  }

  project.statusBeforeArchive = project.status;
  project.status = PROJECT_STATUS.ARCHIVED;
  project.archived = true;
  project.archivedAt = new Date();
  project.archivedBy = actor._id;
  project.updatedBy = actor._id;
  await project.save();

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_ARCHIVED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { name: project.name },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return project.toSafeObject(actor._id);
}

async function restoreProject({ projectId, actor, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  if (!project.archived) {
    throw new AppError('This project is not archived', 409, 'PROJECT_NOT_ARCHIVED');
  }

  project.status = project.statusBeforeArchive || PROJECT_STATUS.PLANNING;
  project.statusBeforeArchive = null;
  project.archived = false;
  project.archivedAt = null;
  project.archivedBy = null;
  project.updatedBy = actor._id;
  await project.save();

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_RESTORED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { name: project.name },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return project.toSafeObject(actor._id);
}

async function softDeleteProject({ projectId, actor, req }) {
  const project = await findActiveProject(projectId, actor.organization);

  if (!canDeleteProject(actor, project)) {
    throw new AppError('You do not have permission to delete this project', 403, 'FORBIDDEN');
  }

  project.deletedAt = new Date();
  project.updatedBy = actor._id;
  await project.save();

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_DELETED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { name: project.name },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return { success: true };
}

async function getProject({ projectId, actor }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanView(actor, project);
  return project.toSafeObject(actor._id);
}

async function listProjects({
  actor,
  search,
  status,
  priority,
  type,
  owner,
  team,
  archived,
  favorite,
  startDate,
  endDate,
  sortBy = 'createdAt',
  sortOrder = 'desc',
  page = 1,
  limit = 20,
}) {
  const conditions = [{ organization: actor.organization }, { deletedAt: null }, buildProjectVisibilityFilter(actor)];

  conditions.push({ archived: Boolean(archived) });

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    conditions.push({ $or: [{ name: regex }, { description: regex }, { client: regex }] });
  }

  if (status) conditions.push({ status });
  if (priority) conditions.push({ priority });
  if (type) conditions.push({ type });
  if (owner) conditions.push({ owner });
  if (team) conditions.push({ team });
  if (favorite) conditions.push({ favoritedBy: actor._id });

  if (startDate || endDate) {
    const dueDate = {};
    if (startDate) dueDate.$gte = startDate;
    if (endDate) dueDate.$lte = endDate;
    conditions.push({ dueDate });
  }

  const query = { $and: conditions };
  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const [projects, total] = await Promise.all([
    Project.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('owner', 'firstName lastName email')
      .populate('members.user', 'firstName lastName email'),
    Project.countDocuments(query),
  ]);

  return {
    projects: projects.map((project) => project.toSafeObject(actor._id)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function favoriteProject({ projectId, actor }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanView(actor, project);

  await Project.updateOne({ _id: project._id }, { $addToSet: { favoritedBy: actor._id } });
  const updated = await Project.findById(project._id);
  return updated.toSafeObject(actor._id);
}

async function unfavoriteProject({ projectId, actor }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanView(actor, project);

  await Project.updateOne({ _id: project._id }, { $pull: { favoritedBy: actor._id } });
  const updated = await Project.findById(project._id);
  return updated.toSafeObject(actor._id);
}

async function addMember({ projectId, actor, userId, role, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  await assertUserInOrganization(userId, actor.organization);

  if (getProjectMemberRole(project, userId)) {
    throw new AppError('This user is already a member of the project', 409, 'ALREADY_MEMBER');
  }

  project.members.push({ user: userId, role: role || PROJECT_MEMBER_ROLES.CONTRIBUTOR, joinedAt: new Date() });
  project.updatedBy = actor._id;
  await project.save();

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_MEMBER_ADDED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { userId, role: role || PROJECT_MEMBER_ROLES.CONTRIBUTOR },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return project.toSafeObject(actor._id);
}

async function updateMemberRole({ projectId, actor, userId, role, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  if (idOfMember(project.owner) === userId) {
    throw new AppError("Transfer ownership to change the owner's role", 400, 'OWNER_ROLE_IMMUTABLE');
  }

  const member = project.members.find((entry) => idOfMember(entry.user) === userId);
  if (!member) {
    throw new AppError('This user is not a member of the project', 404, 'MEMBER_NOT_FOUND');
  }

  const previousRole = member.role;
  member.role = role;
  project.updatedBy = actor._id;
  await project.save();

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_MEMBER_ROLE_CHANGED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { userId, from: previousRole, to: role },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return project.toSafeObject(actor._id);
}

async function removeMember({ projectId, actor, userId, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  if (idOfMember(project.owner) === userId) {
    throw new AppError('The project owner cannot be removed from the project', 400, 'CANNOT_REMOVE_OWNER');
  }

  const before = project.members.length;
  project.members = project.members.filter((entry) => idOfMember(entry.user) !== userId);

  if (project.members.length === before) {
    throw new AppError('This user is not a member of the project', 404, 'MEMBER_NOT_FOUND');
  }

  project.updatedBy = actor._id;
  await project.save();

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_MEMBER_REMOVED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { userId },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return project.toSafeObject(actor._id);
}

async function listMemberCandidates({ projectId, actor, search }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  const memberIds = new Set([idOfMember(project.owner), ...project.members.map((entry) => idOfMember(entry.user))]);

  const query = { organization: actor.organization, _id: { $nin: Array.from(memberIds) } };
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ firstName: regex }, { lastName: regex }, { email: regex }];
  }

  const users = await User.find(query).select('firstName lastName email role').limit(20);

  return {
    candidates: users.map((user) => ({
      id: user._id.toString(),
      fullName: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      role: user.role,
    })),
  };
}

function idOfMember(value) {
  return value._id ? value._id.toString() : value.toString();
}

async function listProjectActivity({ projectId, actor, page = 1, limit = 20 }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanView(actor, project);

  const query = { organization: actor.organization, entityType: 'project', entityId: project._id.toString() };
  const skip = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'firstName lastName email'),
    AuditLog.countDocuments(query),
  ]);

  return {
    activity: logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function transferOwnership({ projectId, actor, newOwnerId, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  if (idOfMember(project.owner) === newOwnerId) {
    throw new AppError('This user is already the owner', 409, 'ALREADY_OWNER');
  }

  const newOwner = await assertUserInOrganization(newOwnerId, actor.organization, 'New owner');

  const ALLOWED_ROLES_FOR_OWNERSHIP = [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.MANAGER, ROLES.HR];
  if (!ALLOWED_ROLES_FOR_OWNERSHIP.includes(newOwner.role)) {
    throw new AppError('Ownership can only be transferred to admins and managers', 403, 'INVALID_OWNER_ROLE');
  }

  const previousOwnerId = project.owner._id ? project.owner._id.toString() : project.owner.toString();
  project.owner = newOwnerId;

  const ownerMember = project.members.find((entry) => idOfMember(entry.user) === newOwnerId);
  if (ownerMember) {
    ownerMember.role = PROJECT_MEMBER_ROLES.OWNER;
  } else {
    project.members.push({ user: newOwnerId, role: PROJECT_MEMBER_ROLES.OWNER, joinedAt: new Date() });
  }

  project.updatedBy = actor._id;
  await project.save();

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_OWNERSHIP_TRANSFERRED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { from: previousOwnerId, to: newOwnerId },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return project.toSafeObject(actor._id);
}

module.exports = {
  addMember,
  archiveProject,
  createProject,
  favoriteProject,
  findActiveProject,
  getProject,
  listMemberCandidates,
  listProjectActivity,
  listProjects,
  removeMember,
  restoreProject,
  softDeleteProject,
  transferOwnership,
  unfavoriteProject,
  updateMemberRole,
  updateProject,
};
