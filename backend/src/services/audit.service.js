const AuditLog = require('../models/AuditLog');

async function logAudit({
  action,
  userId = null,
  organizationId = null,
  entityType = 'auth',
  entityId = null,
  success = true,
  metadata = {},
  req = null,
}) {
  return AuditLog.create({
    action,
    entityId,
    entityType,
    metadata,
    organization: organizationId,
    success,
    user: userId,
    ipAddress: req?.headers['x-forwarded-for']?.split(',')[0]?.trim() || req?.ip || req?.socket?.remoteAddress || 'unknown',
    userAgent: req?.get('user-agent') || '',
  });
}

async function listAuditLogs({ organization, action, userId, startDate, endDate, page = 1, limit = 20 }) {
  const query = { organization };

  if (action) {
    query.action = action;
  }

  if (userId) {
    query.user = userId;
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      query.createdAt.$lte = new Date(endDate);
    }
  }

  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'firstName lastName email'),
    AuditLog.countDocuments(query),
  ]);

  return {
    logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

module.exports = { listAuditLogs, logAudit };