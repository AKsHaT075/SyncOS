const mongoose = require('mongoose');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { ROLES } = require('../constants/roles');

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
		emailVerified: this.emailVerified,
		isActive: this.isActive,
		createdAt: this.createdAt,
		updatedAt: this.updatedAt,
	};
};

userSchema.statics.loginLockThreshold = AUTH_CONSTANTS.ACCOUNT_LOCK_ATTEMPTS;

module.exports = mongoose.model('User', userSchema);
