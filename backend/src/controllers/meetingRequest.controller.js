const asyncHandler = require('../utils/async-handler');
const {
  approveMeetingRequest,
  createMeetingRequest,
  listMeetingRequests,
  rejectMeetingRequest,
  scheduleMeetingRequest,
} = require('../services/meetingRequest.service');

const create = asyncHandler(async (req, res) => {
  const request = await createMeetingRequest({ projectId: req.params.projectId, ...req.body, actor: req.user, req });
  return res.status(201).json({ success: true, request });
});

const list = asyncHandler(async (req, res) => {
  const result = await listMeetingRequests({ projectId: req.params.projectId, ...req.query, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const approve = asyncHandler(async (req, res) => {
  const request = await approveMeetingRequest({ requestId: req.params.id, actor: req.user, ...req.body, req });
  return res.status(200).json({ success: true, request });
});

const reject = asyncHandler(async (req, res) => {
  const request = await rejectMeetingRequest({ requestId: req.params.id, actor: req.user, ...req.body, req });
  return res.status(200).json({ success: true, request });
});

const schedule = asyncHandler(async (req, res) => {
  const request = await scheduleMeetingRequest({ requestId: req.params.id, actor: req.user, ...req.body, req });
  return res.status(200).json({ success: true, request });
});

module.exports = {
  approve,
  create,
  list,
  reject,
  schedule,
};
