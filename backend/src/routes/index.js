const express = require('express');
const authRoutes = require('./auth.routes');
const invitationRoutes = require('./invitation.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/invitations', invitationRoutes);

module.exports = router;