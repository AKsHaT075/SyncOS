const express = require('express');
const validateBody = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const csrfProtection = require('../middlewares/csrf.middleware');
const { ROLES } = require('../constants/roles');
const { accept, invite } = require('../controllers/invitation.controller');
const { acceptInvitationSchema, inviteUserSchema } = require('../validations/invitation.validation');

const router = express.Router();

router.post('/', csrfProtection, authenticate, authorize(ROLES.ORG_ADMIN), validateBody(inviteUserSchema), invite);
router.post('/accept', validateBody(acceptInvitationSchema), accept);

module.exports = router;
