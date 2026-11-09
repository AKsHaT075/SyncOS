const mongoose = require('mongoose');
const { TASK_STATUS, TASK_PRIORITY, TASK_VISIBILITY, TASK_REVIEW_ACTION } = require('../constants/task.constants');

const checklistItemSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    done: { type: Boolean, default: false },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const attachmentRefSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * A submission is one "Submit For Review" package. Every submit/re-submit
 * is pushed here (never overwritten), so the full history stays on the
 * task itself and nothing from an earlier submission is ever lost.
 */
const submissionSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    attachments: { type: [attachmentRefSchema], default: [] },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * Every approve/reject/request-changes action appends here, so "who
 * reviewed this and what did they say" is queryable directly off the task
 * without joining AuditLog — spec explicitly calls out storing Review
 * Date / Reviewer / Remarks. `submissionId` ties the remark to the exact
 * submission it was replying to, since a task can be submitted more than
 * once.
 */
const reviewSchema = new mongoose.Schema(
  {
    action: { type: String, enum: Object.values(TASK_REVIEW_ACTION), required: true },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    remarks: { type: String, default: '', trim: true },
    submissionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    reviewedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const taskSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(TASK_STATUS),
      default: TASK_STATUS.TODO,
      index: true,
    },
    priority: {
      type: String,
      enum: Object.values(TASK_PRIORITY),
      default: TASK_PRIORITY.MEDIUM,
    },
    visibility: {
      type: String,
      enum: Object.values(TASK_VISIBILITY),
      default: TASK_VISIBILITY.PUBLIC,
    },
    startDate: {
      type: Date,
      default: null,
    },
    dueDate: {
      type: Date,
      default: null,
    },
    estimatedHours: {
      type: Number,
      default: null,
      min: 0,
    },
    /**
     * Multiple people can work a task; `owner` is the single accountable
     * person (defaults to the creator, may be reassigned). Kept distinct
     * from `assignees` because "who does the work" and "who answers for
     * it" are different questions once a task has 3+ assignees.
     */
    assignees: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    /**
     * Explicit reviewers the creator chose. Eligibility to actually approve
     * is re-checked at review time via taskAccess.canApproveTask (Project
     * Owner / project-role Manager / org-admin always qualify even if not
     * listed here) — this array only captures deliberate, additional picks.
     */
    approvers: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    labels: {
      type: [String],
      default: [],
    },
    tags: {
      type: [String],
      default: [],
    },
    attachments: {
      type: [attachmentRefSchema],
      default: [],
    },
    checklist: {
      type: [checklistItemSchema],
      default: [],
    },
    submissions: {
      type: [submissionSchema],
      default: [],
    },
    reviews: {
      type: [reviewSchema],
      default: [],
    },
    completedAt: {
      type: Date,
      default: null,
    },
    archived: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

taskSchema.index({ organization: 1, project: 1, status: 1 });
taskSchema.index({ organization: 1, project: 1, archived: 1 });
taskSchema.index({ 'assignees': 1 });
taskSchema.index({ project: 1, dueDate: 1 });
// Calendar: org-wide deadline range queries.
taskSchema.index({ organization: 1, dueDate: 1 });
// Analytics: overdue / status breakdowns, completion and creation trends, and per-assignee workload.
taskSchema.index({ organization: 1, status: 1, dueDate: 1 });
taskSchema.index({ organization: 1, completedAt: 1 });
taskSchema.index({ organization: 1, createdAt: 1 });
taskSchema.index({ organization: 1, assignees: 1, status: 1 });

// `owner`/`assignees`/`approvers`/`createdBy` may come in populated or as
// bare ObjectIds depending on the query that loaded this document.
function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function summarizeUser(value) {
  if (!value) return null;
  if (value.firstName) {
    return { id: value._id.toString(), fullName: `${value.firstName} ${value.lastName}`.trim(), email: value.email };
  }
  return { id: value.toString() };
}

// `project` may come in populated (has `.name`) or as a bare ObjectId
// depending on the query that loaded this document.
function summarizeProject(value) {
  if (!value) return null;
  if (value.name) {
    return { id: value._id.toString(), name: value.name };
  }
  return { id: value.toString() };
}

taskSchema.methods.toSafeObject = function toSafeObject() {
  return {
    id: this._id.toString(),
    organization: this.organization.toString(),
    project: summarizeProject(this.project),
    title: this.title,
    description: this.description,
    status: this.status,
    priority: this.priority,
    visibility: this.visibility,
    startDate: this.startDate,
    dueDate: this.dueDate,
    estimatedHours: this.estimatedHours,
    assignees: this.assignees.map(summarizeUser),
    owner: summarizeUser(this.owner),
    approvers: this.approvers.map(summarizeUser),
    labels: this.labels,
    tags: this.tags,
    attachments: this.attachments.map((attachment) => ({
      id: attachment._id.toString(),
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      uploadedBy: summarizeUser(attachment.uploadedBy),
      uploadedAt: attachment.uploadedAt,
    })),
    checklist: this.checklist.map((item) => ({
      id: item._id.toString(),
      text: item.text,
      done: item.done,
      addedBy: summarizeUser(item.addedBy),
      addedAt: item.addedAt,
    })),
    submissions: this.submissions.map((submission) => ({
      id: submission._id.toString(),
      description: submission.description,
      attachments: submission.attachments.map((attachment) => ({
        id: attachment._id.toString(),
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        uploadedBy: summarizeUser(attachment.uploadedBy),
        uploadedAt: attachment.uploadedAt,
      })),
      submittedBy: summarizeUser(submission.submittedBy),
      submittedAt: submission.submittedAt,
    })),
    reviews: this.reviews.map((review) => ({
      id: review._id.toString(),
      action: review.action,
      reviewer: summarizeUser(review.reviewer),
      remarks: review.remarks,
      submissionId: review.submissionId ? review.submissionId.toString() : null,
      reviewedAt: review.reviewedAt,
    })),
    completedAt: this.completedAt,
    archived: this.archived,
    createdBy: idOf(this.createdBy),
    updatedBy: idOf(this.updatedBy),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('Task', taskSchema);
