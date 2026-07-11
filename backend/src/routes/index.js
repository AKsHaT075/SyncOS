const express = require('express');
const authRoutes = require('./auth.routes');
const invitationRoutes = require('./invitation.routes');
const organizationRoutes = require('./organization.routes');
const auditRoutes = require('./audit.routes');
const platformRoutes = require('./platform.routes');
const projectRoutes = require('./project.routes');
const taskRoutes = require('./task.routes');
const { authenticate } = require('../middlewares/authenticate');
const { listMy } = require('../controllers/task.controller');
const { validateQuery } = require('../middlewares/validate.middleware');
const { listTasksQuerySchema } = require('../validations/task.validation');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/invitations', invitationRoutes);
router.use('/organizations', organizationRoutes);
router.use('/audit-logs', auditRoutes);
router.use('/platform/organizations', platformRoutes);
router.use('/projects', projectRoutes);

// My Tasks — user's tasks across all projects
router.get('/tasks', authenticate, validateQuery(listTasksQuerySchema), listMy);

// Project-scoped tasks
router.use('/projects/:projectId/tasks', taskRoutes);

module.exports = router;