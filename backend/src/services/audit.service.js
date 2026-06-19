const AuditLog = require('../models/AuditLog');

async function logAudit({ action, userId = null, entityType = 'auth', entityId = null, success = true, metadata = {}, req = null }) {
  return AuditLog.create({
    action,
    entityId,
    entityType,
    metadata,
    success,
    user: userId,
    ipAddress: req?.headers['x-forwarded-for']?.split(',')[0]?.trim() || req?.ip || req?.socket?.remoteAddress || 'unknown',
    userAgent: req?.get('user-agent') || '',
  });
}

module.exports = { logAudit };