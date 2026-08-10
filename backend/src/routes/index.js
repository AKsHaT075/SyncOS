const express = require('express');
const authRoutes = require('./auth.routes');
const invitationRoutes = require('./invitation.routes');
const organizationRoutes = require('./organization.routes');
const auditRoutes = require('./audit.routes');
const platformRoutes = require('./platform.routes');
const projectRoutes = require('./project.routes');
const taskRoutes = require('./task.routes');
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