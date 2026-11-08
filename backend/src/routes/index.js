const express = require('express');
const authRoutes = require('./auth.routes');
const invitationRoutes = require('./invitation.routes');
const organizationRoutes = require('./organization.routes');
const auditRoutes = require('./audit.routes');
const platformRoutes = require('./platform.routes');
const projectRoutes = require('./project.routes');
const teamRoutes = require('./team.routes');
const peopleRoutes = require('./people.routes');
const taskRoutes = require('./task.routes');
const documentRoutes = require('./document.routes');
const notificationRoutes = require('./notification.routes');
const calendarRoutes = require('./calendar.routes');
const assetRoutes = require('./asset.routes');
const meetingRoutes = require('./meeting.routes');
const meetingRequestRoutes = require('./meetingRequest.routes');
const { authenticate } = require('../middlewares/authenticate');
const { listMy } = require('../controllers/task.controller');
const { listMy: listMyMeetings } = require('../controllers/meeting.controller');
const { validateQuery } = require('../middlewares/validate.middleware');
const { listTasksQuerySchema } = require('../validations/task.validation');
const { listMeetingsQuerySchema } = require('../validations/meeting.validation');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/invitations', invitationRoutes);
router.use('/organizations', organizationRoutes);
router.use('/audit-logs', auditRoutes);
router.use('/platform/organizations', platformRoutes);
router.use('/projects', projectRoutes);
router.use('/teams', teamRoutes);
router.use('/people', peopleRoutes);
router.use('/documents', documentRoutes);
router.use('/notifications', notificationRoutes);
router.use('/calendar', calendarRoutes);
router.use('/assets', assetRoutes);

// My Tasks — user's tasks across all projects
router.get('/tasks', authenticate, validateQuery(listTasksQuerySchema), listMy);

// My Meetings — user's meetings across all projects
router.get('/meetings', authenticate, validateQuery(listMeetingsQuerySchema), listMyMeetings);

// Project-scoped tasks
router.use('/projects/:projectId/tasks', taskRoutes);

// Project-scoped meetings and meeting requests
router.use('/projects/:projectId/meetings', meetingRoutes);
router.use('/projects/:projectId/meeting-requests', meetingRequestRoutes);

module.exports = router;