const asyncHandler = require('../utils/async-handler');
const {
  addParticipants,
  cancelMeeting,
  createInstantMeeting,
  createScheduledMeeting,
  endMeetingForEveryone,
  getJoinToken,
  getMeeting,
  kickParticipant,
  listMeetingActivity,
  listMeetings,
  listMyMeetings,
  removeParticipant,
  updateMeeting,
} = require('../services/meeting.service');

const schedule = asyncHandler(async (req, res) => {
  const meeting = await createScheduledMeeting({ projectId: req.params.projectId, ...req.body, creator: req.user, req });
  return res.status(201).json({ success: true, meeting });
});

const instant = asyncHandler(async (req, res) => {
  const meeting = await createInstantMeeting({ projectId: req.params.projectId, ...req.body, creator: req.user, req });
  return res.status(201).json({ success: true, meeting });
});

const list = asyncHandler(async (req, res) => {
  const result = await listMeetings({ projectId: req.params.projectId, ...req.query, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const listMy = asyncHandler(async (req, res) => {
  const result = await listMyMeetings({ ...req.query, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const getById = asyncHandler(async (req, res) => {
  const meeting = await getMeeting({ meetingId: req.params.id, actor: req.user });
  return res.status(200).json({ success: true, meeting });
});

const update = asyncHandler(async (req, res) => {
  const meeting = await updateMeeting({ meetingId: req.params.id, actor: req.user, updates: req.body, req });
  return res.status(200).json({ success: true, meeting });
});

const cancel = asyncHandler(async (req, res) => {
  const meeting = await cancelMeeting({ meetingId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, meeting });
});

const addParticipantsHandler = asyncHandler(async (req, res) => {
  const meeting = await addParticipants({ meetingId: req.params.id, actor: req.user, ...req.body, req });
  return res.status(200).json({ success: true, meeting });
});

const removeParticipantHandler = asyncHandler(async (req, res) => {
  const meeting = await removeParticipant({ meetingId: req.params.id, userId: req.params.userId, actor: req.user, req });
  return res.status(200).json({ success: true, meeting });
});

const kickParticipantHandler = asyncHandler(async (req, res) => {
  const result = await kickParticipant({ meetingId: req.params.id, userId: req.params.userId, actor: req.user, req });
  return res.status(200).json(result);
});

const token = asyncHandler(async (req, res) => {
  const result = await getJoinToken({ meetingId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, ...result });
});

const end = asyncHandler(async (req, res) => {
  const meeting = await endMeetingForEveryone({ meetingId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, meeting });
});

const activity = asyncHandler(async (req, res) => {
  const result = await listMeetingActivity({ meetingId: req.params.id, actor: req.user, ...req.query });
  return res.status(200).json({ success: true, ...result });
});

module.exports = {
  activity,
  addParticipantsHandler,
  cancel,
  end,
  getById,
  instant,
  kickParticipantHandler,
  list,
  listMy,
  removeParticipantHandler,
  schedule,
  token,
  update,
};
