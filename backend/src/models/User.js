const mongoose = require('mongoose');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { ROLES } = require('../constants/roles');
const { ROLE_PERMISSIONS } = require('../constants/rolePermissions');

const userSchema = new mongoose.Schema(
	{
		organization: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			default: null,
			index: true,
		},
		firstName: {
			type: String,
			required: true,
			trim: true,
		},
		lastName: {
			type: String,
			required: true,
			trim: true,
		},
		email: {
			type: String,
			required: true,
			unique: true,
			lowercase: true,
			trim: true,
			index: true,
		},
		passwordHash: {
			type: String,
			required: true,
			select: false,
		},
		role: {
			type: String,
			enum: Object.values(ROLES),
			default: ROLES.EMPLOYEE,
			index: true,
		},
		team: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Team',
			default: null,
			index: true,
		},
		skills: {
			type: [String],
			default: [],
		},
		emailVerified: {
			type: Boolean,
			default: false,
			index: true,
		},
		emailVerifiedAt: {
			type: Date,
			default: null,
		},
		failedLoginAttempts: {
			type: Number,
			default: 0,
		},
		lockUntil: {
			type: Date,
			default: null,
		},
		lastLoginAt: {
			type: Date,
			default: null,
		},
		passwordChangedAt: {
			type: Date,
			default: null,
		},
		tokenVersion: {
			type: Number,
			default: 0,
		},
		isActive: {
			type: Boolean,
			default: true,
			index: true,
		},
		/**
		 * Org-level access block. Distinct from isActive: a blocked user can
		 * still authenticate (so a future multi-org account isn't locked out
		 * everywhere), but every org-scoped route rejects them with
		 * ORG_BLOCKED (see requireOrgAccess). isActive remains the full
		 * account deactivation switch.
		 */
		orgBlocked: {
			type: Boolean,
			default: false,
		},
		orgBlockedAt: {
			type: Date,
			default: null,
		},
		hasCreatedOrganization: {
			type: Boolean,
			default: false,
		},
		/**
		 * The user's manual preference. "offline" is never stored here — it's
		 * derived at read time from whether any session has refreshed
		 * recently (see PRESENCE.INACTIVITY_THRESHOLD_MS / getProfile).
		 */
		presenceStatus: {
			type: String,
			enum: ['online', 'dnd'],
			default: 'online',
		},
	},
	{
		timestamps: true,
	}
);

userSchema.virtual('fullName').get(function getFullName() {
	return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.methods.isLocked = function isLocked() {
	return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

userSchema.methods.toSafeObject = function toSafeObject() {
	return {
		id: this._id.toString(),
		firstName: this.firstName,
		lastName: this.lastName,
		fullName: `${this.firstName} ${this.lastName}`.trim(),
		email: this.email,
		role: this.role,
		permissions: ROLE_PERMISSIONS[this.role] || [],
		organization: this.organization ? this.organization.toString() : null,
		team: this.team ? this.team.toString() : null,
		skills: this.skills,
		orgBlocked: this.orgBlocked,
		emailVerified: this.emailVerified,
		presenceStatus: this.presenceStatus,
		isActive: this.isActive,
		hasCreatedOrganization: this.hasCreatedOrganization,
		createdAt: this.createdAt,
		updatedAt: this.updatedAt,
	};
};

userSchema.statics.loginLockThreshold = AUTH_CONSTANTS.ACCOUNT_LOCK_ATTEMPTS;

module.exports = mongoose.model('User', userSchema);
