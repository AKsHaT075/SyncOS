const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const {
  activity,
  addParticipantsHandler,
  cancel,
  end,
  getById,
  instant,
  kickParticipantHandler,
  list,
  removeParticipantHandler,
  schedule,
  token,
  update,
} = require('../controllers/meeting.controller');
const {
  activityQuerySchema,
  addParticipantsSchema,
  createMeetingSchema,
  instantMeetingSchema,
  listMeetingsQuerySchema,
  updateMeetingSchema,
} = require('../validations/meeting.validation');

// Mounted at /projects/:projectId/meetings — mergeParams so req.params.projectId
// is visible here alongside this router's own :id. Permission decisions are
// project-role-aware and happen inside meeting.service.js — see meetingAccess.js.
const router = express.Router({ mergeParams: true });

router.use(authenticate);

router.get('/', validateQuery(listMeetingsQuerySchema), list);
router.post('/', validateBody(createMeetingSchema), schedule);
router.post('/instant', validateBody(instantMeetingSchema), instant);

router.get('/:id', getById);
router.patch('/:id', validateBody(updateMeetingSchema), update);
router.post('/:id/cancel', cancel);
router.post('/:id/end', end);

router.post('/:id/participants', validateBody(addParticipantsSchema), addParticipantsHandler);
router.delete('/:id/participants/:userId', removeParticipantHandler);
router.post('/:id/room-participants/:userId/kick', kickParticipantHandler);

router.post('/:id/token', token);
router.get('/:id/activity', validateQuery(activityQuerySchema), activity);

module.exports = router;
