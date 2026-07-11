const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { TASK_UPLOAD_ROOT } = require('../middlewares/upload');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { ROLES } = require('../constants/roles');
const { PROJECT_MEMBER_ROLES } = require('../constants/project.constants');
const { TASK_STATUS, TASK_STATUS_TRANSITIONS, TASK_REVIEW_ACTION, TASK_VISIBILITY } = require('../constants/task.constants');
const { canViewProject, getProjectMemberRole } = require('../utils/projectAccess');
const {
  canApproveTask,
  canCreateTask,
  canEditTask,
  canManageTask,
  canSubmitForReview,
  canViewTask,
} = require('../utils/taskAccess');
const { findActiveProject } = require('./project.service');
const Task = require('../models/Task');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { logAudit } = require('./audit.service');

const TASK_POPULATE = ['owner', 'assignees', 'approvers', 'checklist.addedBy', 'submissions.submittedBy', 'reviews.reviewer'];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function populateTask(task) {
  await task.populate([
    { path: 'owner', select: 'firstName lastName email' },
    { path: 'assignees', select: 'firstName lastName email' },
    { path: 'approvers', select: 'firstName lastName email' },
    { path: 'checklist.addedBy', select: 'firstName lastName email' },
    { path: 'submissions.submittedBy', select: 'firstName lastName email' },
    { path: 'reviews.reviewer', select: 'firstName lastName email' },
  ]);
  return task;
}

async function findActiveTask(taskId, organization) {
  if (!mongoose.isValidObjectId(taskId)) {
    throw new AppError('Task not found', 404, 'NOT_FOUND');
  }

  const task = await Task.findOne({ _id: taskId, organization, deletedAt: null });
  if (!task) {
    throw new AppError('Task not found', 404, 'NOT_FOUND');
  }

  return task;
}

function assertCanView(actor, project, task) {
  if (!canViewTask(actor, project, task)) {
    throw new AppError('You do not have access to this task', 403, 'FORBIDDEN');
  }
}

function assertCanManage(actor, project, task) {
  if (!canManageTask(actor, project, task)) {
    throw new AppError('You do not have permission to manage this task', 403, 'FORBIDDEN');
  }
}

function assertCanEdit(actor, project, task) {
  if (!canEditTask(actor, project, task)) {
    throw new AppError('You do not have permission to edit this task', 403, 'FORBIDDEN');
  }
}

async function assertUsersInProject(userIds, project, label) {
  if (!userIds || userIds.length === 0) return;

  const uniqueIds = [...new Set(userIds.map((id) => id.toString()))];

  const users = await User.find({ _id: { $in: uniqueIds }, organization: project.organization }).select('_id');
  if (users.length !== uniqueIds.length) {
    throw new AppError(`One or more ${label} could not be found in this organization`, 404, 'NOT_FOUND');
  }

  const notInProject = uniqueIds.filter((id) => !getProjectMemberRole(project, id));
  if (notInProject.length > 0) {
    throw new AppError(`${label} must be members of the project`, 400, 'NOT_PROJECT_MEMBER');
  }
}

function assertProjectAcceptingTasks(project) {
  if (project.archived) {
    throw new AppError('Cannot add tasks to an archived project', 400, 'PROJECT_ARCHIVED');
  }
}

function assertDatesWithinProject(project, { startDate, dueDate }) {
  if (startDate && project.startDate && startDate < project.startDate) {
    throw new AppError('Start date cannot be before the project start date', 400, 'INVALID_START_DATE');
  }
  if (dueDate && project.dueDate && dueDate > project.dueDate) {
    throw new AppError('Due date cannot be after the project due date', 400, 'INVALID_DUE_DATE');
  }
  if (startDate && dueDate && startDate > dueDate) {
    throw new AppError('Due date must be on or after the start date', 400, 'INVALID_DUE_DATE');
  }
}

async function createTask({
  projectId,
  title,
  description,
  priority,
  visibility,
  startDate,
  dueDate,
  estimatedHours,
  assignees,
  owner,
  approvers,
  labels,
  tags,
  creator,
  req,
}) {
  const project = await findActiveProject(projectId, creator.organization);

  if (!canCreateTask(creator, project)) {
    throw new AppError('You do not have permission to create tasks in this project', 403, 'FORBIDDEN');
  }

  assertProjectAcceptingTasks(project);
  assertDatesWithinProject(project, { startDate, dueDate });

  const ownerId = owner || creator._id;
  await assertUsersInProject([ownerId], project, 'Owner');
  if (assignees?.length) await assertUsersInProject(assignees, project, 'Assignees');
  if (approvers?.length) await assertUsersInProject(approvers, project, 'Approvers');

  const task = await Task.create({
    organization: creator.organization,
    project: project._id,
    title: title.trim(),
    description: description || '',
    priority,
    visibility,
    startDate: startDate || null,
    dueDate: dueDate || null,
    estimatedHours: estimatedHours ?? null,
    assignees: assignees || [],
    owner: ownerId,
    approvers: approvers || [],
    labels: labels || [],
    tags: tags || [],
    createdBy: creator._id,
    updatedBy: creator._id,
  });

  await logAudit({
    action: AUDIT_EVENTS.TASK_CREATED,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { title: task.title, project: project._id.toString() },
    organizationId: creator.organization,
    req,
    userId: creator._id,
  });

  await populateTask(task);
  return task.toSafeObject();
}

async function getTask({ taskId, actor }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);
  assertCanView(actor, project, task);

  await populateTask(task);
  return task.toSafeObject();
}

async function listTasks({
  projectId,
  actor,
  search,
  status,
  priority,
  assignee,
  label,
  visibility,
  archived,
  dueBefore,
  dueAfter,
  sortBy = 'createdAt',
  sortOrder = 'desc',
  page = 1,
  limit = 20,
}) {
  const project = await findActiveProject(projectId, actor.organization);
  if (!canViewProject(actor, project)) {
    throw new AppError('You do not have access to this project', 403, 'FORBIDDEN');
  }

  const memberRole = getProjectMemberRole(project, actor._id);
  const isOrgAdmin = actor.role === ROLES.ORG_ADMIN || actor.role === ROLES.ADMIN;
  const isProjectManager = memberRole === PROJECT_MEMBER_ROLES.OWNER || memberRole === PROJECT_MEMBER_ROLES.MANAGER;

  const conditions = [{ organization: actor.organization }, { project: project._id }, { deletedAt: null }];
  conditions.push({ archived: Boolean(archived) });

  // Non-managers only ever see Public tasks plus Private tasks they're
  // personally attached to (assignee or approver) — mirrors canViewTask.
  if (!isOrgAdmin && !isProjectManager) {
    conditions.push({
      $or: [{ visibility: TASK_VISIBILITY.PUBLIC }, { assignees: actor._id }, { approvers: actor._id }],
    });
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    conditions.push({ $or: [{ title: regex }, { description: regex }] });
  }

  if (status) conditions.push({ status });
  if (priority) conditions.push({ priority });
  if (assignee) conditions.push({ assignees: assignee });
  if (label) conditions.push({ labels: label });
  if (visibility) conditions.push({ visibility });

  if (dueBefore || dueAfter) {
    const dueDate = {};
    if (dueAfter) dueDate.$gte = dueAfter;
    if (dueBefore) dueDate.$lte = dueBefore;
    conditions.push({ dueDate });
  }

  const query = { $and: conditions };
  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const [tasks, total] = await Promise.all([
    Task.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('owner', 'firstName lastName email')
      .populate('assignees', 'firstName lastName email')
      .populate('approvers', 'firstName lastName email'),
    Task.countDocuments(query),
  ]);

  return {
    tasks: tasks.map((task) => task.toSafeObject()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function updateTask({ taskId, actor, updates, req }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);
  assertCanEdit(actor, project, task);

  // Reassignment, approver changes, and owner changes are manage-only —
  // an assignee editing their own task (allowed by canEditTask) may not
  // silently hand the task to someone else or add approvers.
  const manageOnlyFields = ['assignees', 'owner', 'approvers', 'visibility', 'priority'];
  const touchesManageOnly = manageOnlyFields.some((field) => updates[field] !== undefined);
  if (touchesManageOnly) {
    assertCanManage(actor, project, task);
  }

  const nextStartDate = updates.startDate !== undefined ? updates.startDate : task.startDate;
  const nextDueDate = updates.dueDate !== undefined ? updates.dueDate : task.dueDate;
  assertDatesWithinProject(project, { startDate: nextStartDate, dueDate: nextDueDate });

  if (updates.owner) await assertUsersInProject([updates.owner], project, 'Owner');
  if (updates.assignees) await assertUsersInProject(updates.assignees, project, 'Assignees');
  if (updates.approvers) await assertUsersInProject(updates.approvers, project, 'Approvers');

  if (updates.status && updates.status !== task.status) {
    // Managers can change status at any time, including on an archived
    // task — only the assignee-facing submit action is blocked while
    // archived (see submitForReview).
    assertCanManage(actor, project, task);
    const allowedNext = TASK_STATUS_TRANSITIONS[task.status] || [];
    if (!allowedNext.includes(updates.status)) {
      throw new AppError(
        `Cannot move a task from ${task.status} to ${updates.status} directly`,
        400,
        'INVALID_STATUS_TRANSITION'
      );
    }
  }

  const assigneesChanged = updates.assignees !== undefined;
  const previousAssignees = task.assignees.map((id) => id.toString());
  const statusChanged = updates.status && updates.status !== task.status;
  const previousStatus = task.status;

  Object.assign(task, updates);
  if (statusChanged && updates.status === TASK_STATUS.COMPLETED) {
    task.completedAt = new Date();
  }
  task.updatedBy = actor._id;
  await task.save();

  if (assigneesChanged) {
    await logAudit({
      action: previousAssignees.length === 0 ? AUDIT_EVENTS.TASK_ASSIGNED : AUDIT_EVENTS.TASK_REASSIGNED_EVENT,
      entityId: task._id.toString(),
      entityType: 'task',
      metadata: { from: previousAssignees, to: task.assignees.map((id) => id.toString()) },
      organizationId: actor.organization,
      req,
      userId: actor._id,
    });
  }

  if (statusChanged) {
    await logAudit({
      action: AUDIT_EVENTS.TASK_STATUS_CHANGED,
      entityId: task._id.toString(),
      entityType: 'task',
      metadata: { from: previousStatus, to: task.status },
      organizationId: actor.organization,
      req,
      userId: actor._id,
    });
  }

  await logAudit({
    action: AUDIT_EVENTS.TASK_UPDATED,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { fields: Object.keys(updates) },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await populateTask(task);
  return task.toSafeObject();
}

function filesToAttachmentRefs(files, uploaderId) {
  return (files || []).map((file) => ({
    fileName: file.filename,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: uploaderId,
    uploadedAt: new Date(),
  }));
}

async function submitForReview({ taskId, actor, description, files, req }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);

  if (!canSubmitForReview(actor, task)) {
    throw new AppError('Only an assignee may submit this task while it is In Progress or In Review', 403, 'FORBIDDEN');
  }

  if (task.archived) {
    throw new AppError('Cannot submit an archived task. Unarchive it first.', 400, 'TASK_ARCHIVED');
  }

  task.submissions.push({
    description,
    attachments: filesToAttachmentRefs(files, actor._id),
    submittedBy: actor._id,
    submittedAt: new Date(),
  });
  task.status = TASK_STATUS.IN_REVIEW;
  task.updatedBy = actor._id;
  await task.save();

  await logAudit({
    action: AUDIT_EVENTS.TASK_SUBMITTED,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { description },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await populateTask(task);
  return task.toSafeObject();
}

async function reviewTask({ taskId, actor, action, remarks, submissionId, req }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);

  if (!canApproveTask(actor, project, task)) {
    throw new AppError('You do not have permission to review this task', 403, 'FORBIDDEN');
  }

  if (task.status !== TASK_STATUS.IN_REVIEW) {
    throw new AppError('Only tasks that are In Review can be reviewed', 400, 'INVALID_STATUS_TRANSITION');
  }

  // Reply targets whichever submission the reviewer clicked "Reply" on; falls
  // back to the latest submission if none was specified (or it doesn't
  // belong to this task).
  const targetSubmission =
    (submissionId && task.submissions.id(submissionId)) || task.submissions[task.submissions.length - 1];
  task.reviews.push({
    action,
    reviewer: actor._id,
    remarks: remarks || '',
    submissionId: targetSubmission ? targetSubmission._id : null,
    reviewedAt: new Date(),
  });

  // An "Approved" reply is just a reply — it does not complete the task.
  // The task stays In Review until a manager explicitly marks it Completed
  // (via the status dropdown), so approving multiple updates in a row never
  // has a surprise side effect.
  let auditEvent;
  if (action === TASK_REVIEW_ACTION.APPROVED) {
    auditEvent = AUDIT_EVENTS.TASK_APPROVED;
  } else if (action === TASK_REVIEW_ACTION.REJECTED) {
    task.status = TASK_STATUS.IN_PROGRESS;
    auditEvent = AUDIT_EVENTS.TASK_REJECTED;
  } else {
    task.status = TASK_STATUS.IN_PROGRESS;
    auditEvent = AUDIT_EVENTS.TASK_CHANGES_REQUESTED;
  }

  task.updatedBy = actor._id;
  await task.save();

  await logAudit({
    action: auditEvent,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { remarks },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await populateTask(task);
  return task.toSafeObject();
}

async function addAttachment({ taskId, actor, file, req }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);
  assertCanEdit(actor, project, task);

  if (!file) {
    throw new AppError('A file is required', 400, 'FILE_REQUIRED');
  }

  const [attachment] = filesToAttachmentRefs([file], actor._id);
  task.attachments.push(attachment);
  task.updatedBy = actor._id;
  await task.save();

  await logAudit({
    action: AUDIT_EVENTS.TASK_ATTACHMENT_ADDED,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { name: attachment.originalName },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await populateTask(task);
  return task.toSafeObject();
}

async function removeAttachment({ taskId, attachmentId, actor, req }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);

  const attachment = task.attachments.id(attachmentId);
  if (!attachment) {
    throw new AppError('Attachment not found', 404, 'NOT_FOUND');
  }

  const isUploader = attachment.uploadedBy.toString() === actor._id.toString();
  if (!isUploader) {
    assertCanManage(actor, project, task);
  }

  const absolutePath = path.join(TASK_UPLOAD_ROOT, attachment.fileName);
  attachment.deleteOne();
  task.updatedBy = actor._id;
  await task.save();
  await fs.unlink(absolutePath).catch(() => {});

  await logAudit({
    action: AUDIT_EVENTS.TASK_ATTACHMENT_REMOVED,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { name: attachment.originalName },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await populateTask(task);
  return task.toSafeObject();
}

async function getAttachmentForDownload({ taskId, attachmentId, actor }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);
  assertCanView(actor, project, task);

  const attachment = task.attachments.id(attachmentId);
  if (!attachment) {
    throw new AppError('Attachment not found', 404, 'NOT_FOUND');
  }

  return { attachment, absolutePath: path.join(TASK_UPLOAD_ROOT, attachment.fileName) };
}

async function archiveTask({ taskId, actor, req }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);
  assertCanManage(actor, project, task);

  task.archived = true;
  task.updatedBy = actor._id;
  await task.save();

  await logAudit({
    action: AUDIT_EVENTS.TASK_ARCHIVED,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { title: task.title },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return task.toSafeObject();
}

async function unarchiveTask({ taskId, actor, req }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);
  assertCanManage(actor, project, task);

  task.archived = false;
  task.updatedBy = actor._id;
  await task.save();

  await logAudit({
    action: AUDIT_EVENTS.TASK_UNARCHIVED,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { title: task.title },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return task.toSafeObject();
}

async function softDeleteTask({ taskId, actor, req }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);
  assertCanManage(actor, project, task);

  task.deletedAt = new Date();
  task.updatedBy = actor._id;
  await task.save();

  await logAudit({
    action: AUDIT_EVENTS.TASK_DELETED,
    entityId: task._id.toString(),
    entityType: 'task',
    metadata: { title: task.title },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return { success: true };
}

async function listTaskActivity({ taskId, actor, page = 1, limit = 20 }) {
  const task = await findActiveTask(taskId, actor.organization);
  const project = await findActiveProject(task.project, actor.organization);
  assertCanView(actor, project, task);

  const query = { organization: actor.organization, entityType: 'task', entityId: task._id.toString() };
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

async function listMyTasks({
  actor,
  search,
  status,
  priority,
  label,
  visibility,
  archived,
  dueBefore,
  dueAfter,
  sortBy = 'createdAt',
  sortOrder = 'desc',
  page = 1,
  limit = 20,
}) {
  const isOrgAdmin = actor.role === ROLES.ORG_ADMIN || actor.role === ROLES.ADMIN;

  // Tasks where user is involved: assigned, owner, or approver. Also include
  // Public tasks in projects they're a member of (for context).
  const conditions = [{ organization: actor.organization }, { deletedAt: null }];
  conditions.push({ archived: Boolean(archived) });

  conditions.push({
    $or: [
      { assignees: actor._id },
      { owner: actor._id },
      { approvers: actor._id },
      ...(isOrgAdmin ? [] : [{ visibility: TASK_VISIBILITY.PUBLIC }]),
    ],
  });

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    conditions.push({ $or: [{ title: regex }, { description: regex }] });
  }

  if (status) conditions.push({ status });
  if (priority) conditions.push({ priority });
  if (label) conditions.push({ labels: label });
  if (visibility) conditions.push({ visibility });

  if (dueBefore || dueAfter) {
    const dueDate = {};
    if (dueAfter) dueDate.$gte = dueAfter;
    if (dueBefore) dueDate.$lte = dueBefore;
    conditions.push({ dueDate });
  }

  const query = { $and: conditions };
  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const [tasks, total] = await Promise.all([
    Task.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('owner', 'firstName lastName email')
      .populate('assignees', 'firstName lastName email')
      .populate('approvers', 'firstName lastName email')
      .populate('project', 'name'),
    Task.countDocuments(query),
  ]);

  return {
    tasks: tasks.map((task) => task.toSafeObject()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

module.exports = {
  addAttachment,
  archiveTask,
  createTask,
  findActiveTask,
  getAttachmentForDownload,
  getTask,
  listMyTasks,
  listTaskActivity,
  listTasks,
  removeAttachment,
  reviewTask,
  softDeleteTask,
  submitForReview,
  unarchiveTask,
  updateTask,
};
