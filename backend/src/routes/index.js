const express = require('express');
const authRoutes = require('./auth.routes');
const invitationRoutes = require('./invitation.routes');
const organizationRoutes = require('./organization.routes');
const auditRoutes = require('./audit.routes');
const platformRoutes = require('./platform.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/invitations', invitationRoutes);
router.use('/organizations', organizationRoutes);
router.use('/audit-logs', auditRoutes);
router.use('/platform/organizations', platformRoutes);

module.exports = router;