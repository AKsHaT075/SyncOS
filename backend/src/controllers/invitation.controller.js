const asyncHandler = require('../utils/async-handler');
const { acceptInvitation, inviteUser } = require('../services/invitation.service');

const invite = asyncHandler(async (req, res) => {
  const result = await inviteUser({ ...req.body, inviter: req.user, req });
  return res.status(201).json({ success: true, ...result });
});

const accept = asyncHandler(async (req, res) => {
  const result = await acceptInvitation({ ...req.body, req });
  return res.status(201).json({ success: true, ...result });
});

module.exports = {
  accept,
  invite,
};
