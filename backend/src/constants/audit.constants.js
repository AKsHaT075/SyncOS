const AUDIT_EVENTS = Object.freeze({
  EMAIL_OTP_SENT: 'email_otp.sent',
  EMAIL_OTP_VERIFIED: 'email_otp.verified',
  LOGIN_FAILED: 'auth.login_failed',
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  LOGOUT_ALL: 'auth.logout_all',
  LOGOUT_CURRENT: 'auth.logout_current',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  SESSION_REVOKED: 'auth.session_revoked',
  TOKEN_REFRESHED: 'auth.token_refreshed',
  USER_REGISTERED: 'user.registered',

  ROLE_CHANGED: 'rbac.role_changed',
  PERMISSION_CHANGED: 'rbac.permission_changed',
  USER_INVITED: 'rbac.user_invited',
  INVITE_ACCEPTED: 'rbac.invite_accepted',
  TEAM_DELETED: 'rbac.team_deleted',
  PROJECT_DELETED: 'rbac.project_deleted',
  TASK_REASSIGNED: 'rbac.task_reassigned',
});

module.exports = { AUDIT_EVENTS };