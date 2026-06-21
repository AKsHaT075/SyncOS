const asyncHandler = require('../utils/async-handler');
const {
  acceptInvitation,
  inviteUser,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} = require('../services/invitation.service');

const invite = asyncHandler(async (req, res) => {
  const result = await inviteUser({ ...req.body, inviter: req.user, req });
  return res.status(201).json({ success: true, ...result });
});

const accept = asyncHandler(async (req, res) => {
  const result = await acceptInvitation({ ...req.body, req });
  return res.status(201).json({ success: true, ...result });
});

const list = asyncHandler(async (req, res) => {
  const result = await listInvitations({ ...req.query, organization: req.user.organization });
  return res.status(200).json({ success: true, ...result });
});

const resend = asyncHandler(async (req, res) => {
  const result = await resendInvitation({
    invitationId: req.params.id,
    organization: req.user.organization,
    inviter: req.user,
    req,
  });
  return res.status(200).json({ success: true, ...result });
});

const revoke = asyncHandler(async (req, res) => {
  const result = await revokeInvitation({
    invitationId: req.params.id,
    organization: req.user.organization,
    inviter: req.user,
    req,
  });
  return res.status(200).json({ success: true, ...result });
});

module.exports = {
  accept,
  invite,
  list,
  resend,
  revoke,
};
