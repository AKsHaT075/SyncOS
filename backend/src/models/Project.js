const mongoose = require('mongoose');
const {
  PROJECT_STATUS,
  PROJECT_PRIORITY,
  PROJECT_VISIBILITY,
  PROJECT_TYPE,
  PROJECT_MEMBER_ROLES,
} = require('../constants/project.constants');

const memberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: Object.values(PROJECT_MEMBER_ROLES),
      default: PROJECT_MEMBER_ROLES.CONTRIBUTOR,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      default: null,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    type: {
      type: String,
      enum: Object.values(PROJECT_TYPE),
      default: PROJECT_TYPE.OTHER,
    },
    status: {
      type: String,
      enum: Object.values(PROJECT_STATUS),
      default: PROJECT_STATUS.PLANNING,
    },
    priority: {
      type: String,
      enum: Object.values(PROJECT_PRIORITY),
      default: PROJECT_PRIORITY.MEDIUM,
    },
    visibility: {
      type: String,
      enum: Object.values(PROJECT_VISIBILITY),
      default: PROJECT_VISIBILITY.TEAM,
    },
    /**
     * A project can be purely internal (no external client) — isInternal
     * lets that be stated explicitly rather than inferred from an empty
     * `client` string, which is ambiguous with "not filled in yet".
     */
    isInternal: {
      type: Boolean,
      default: false,
    },
    client: {
      type: String,
      default: '',
      trim: true,
    },
    budget: {
      type: Number,
      default: null,
      min: 0,
    },
    /**
     * What this points to depends on `type` (GitHub repo for Technical,
     * design file for Design, etc.) — the frontend picks the label, this
     * just stores the URL.
     */
    resourceLink: {
      type: String,
      default: '',
      trim: true,
    },
    startDate: {
      type: Date,
      default: null,
    },
    dueDate: {
      type: Date,
      default: null,
    },
    /**
     * Archiving is a reversible lifecycle action layered on top of `status`
     * rather than a status value itself — see project.constants.js. These
     * three fields let restore() put the project back exactly where it was.
     */
    archived: {
      type: Boolean,
      default: false,
      index: true,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    statusBeforeArchive: {
      type: String,
      enum: Object.values(PROJECT_STATUS),
      default: null,
    },
    /**
     * Favoriting is per-user, so it can't be a single boolean on the
     * project — it's the set of users who favorited it. isFavorite is
     * derived relative to the requesting user in toSafeObject().
     */
    favoritedBy: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    members: {
      type: [memberSchema],
      default: [],
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

projectSchema.index({ organization: 1, slug: 1 }, { unique: true });
projectSchema.index(
  { organization: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);
projectSchema.index({ 'members.user': 1 });
projectSchema.index({ organization: 1, archived: 1 });
// Calendar: project deadline range queries.
projectSchema.index({ organization: 1, dueDate: 1 });

// `owner`/`members.user` may or may not be populated depending on the query
// that loaded this document — these helpers work either way.
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

projectSchema.methods.toSafeObject = function toSafeObject(currentUserId = null) {
  const currentUserIdStr = currentUserId ? currentUserId.toString() : null;
  const myMember = currentUserIdStr
    ? this.members.find((member) => idOf(member.user) === currentUserIdStr)
    : null;

  return {
    id: this._id.toString(),
    organization: this.organization.toString(),
    owner: summarizeUser(this.owner),
    team: this.team ? this.team.toString() : null,
    name: this.name,
    slug: this.slug,
    description: this.description,
    type: this.type,
    status: this.status,
    priority: this.priority,
    visibility: this.visibility,
    isInternal: this.isInternal,
    client: this.client,
    budget: this.budget,
    resourceLink: this.resourceLink,
    startDate: this.startDate,
    dueDate: this.dueDate,
    archived: this.archived,
    archivedAt: this.archivedAt,
    memberCount: this.members.length,
    members: this.members.map((member) => ({
      user: summarizeUser(member.user),
      role: member.role,
      joinedAt: member.joinedAt,
    })),
    myRole:
      currentUserIdStr && idOf(this.owner) === currentUserIdStr
        ? PROJECT_MEMBER_ROLES.OWNER
        : myMember?.role || null,
    isFavorite: currentUserIdStr
      ? this.favoritedBy.some((id) => id.toString() === currentUserIdStr)
      : false,
    createdBy: this.createdBy.toString(),
    updatedBy: this.updatedBy ? this.updatedBy.toString() : null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('Project', projectSchema);
