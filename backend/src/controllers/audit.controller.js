const asyncHandler = require('../utils/async-handler');
const { listAuditLogs } = require('../services/audit.service');

const list = asyncHandler(async (req, res) => {
  const result = await listAuditLogs({ ...req.query, organization: req.user.organization });
  return res.status(200).json({ success: true, ...result });
});

module.exports = {
  list,
};
