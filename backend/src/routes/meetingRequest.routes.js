const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const { approve, create, list, reject, schedule } = require('../controllers/meetingRequest.controller');
const {
  createMeetingRequestSchema,
  decisionSchema,
  listMeetingRequestsQuerySchema,
  scheduleDecisionSchema,
} = require('../validations/meetingRequest.validation');

// Mounted at /projects/:projectId/meeting-requests — mergeParams so
// req.params.projectId is visible here. Contributors/Viewers create
// requests; scheduler-eligible roles (see meetingAccess.canScheduleMeeting)
// approve/reject/schedule them.
const router = express.Router({ mergeParams: true });

router.use(authenticate);

router.get('/', validateQuery(listMeetingRequestsQuerySchema), list);
router.post('/', validateBody(createMeetingRequestSchema), create);

router.post('/:id/approve', validateBody(decisionSchema), approve);
router.post('/:id/reject', validateBody(decisionSchema), reject);
router.post('/:id/schedule', validateBody(scheduleDecisionSchema), schedule);

module.exports = router;
