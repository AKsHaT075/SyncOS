const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const { ROLES } = require('../constants/roles');
const { accept, acceptExisting, invite, list, resend, revoke } = require('../controllers/invitation.controller');
const {
  acceptExistingInvitationSchema,
  acceptInvitationSchema,
  inviteUserSchema,
  listInvitationsQuerySchema,
} = require('../validations/invitation.validation');

const router = express.Router();

router.get('/', authenticate, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), validateQuery(listInvitationsQuerySchema), list);
router.post('/', authenticate, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), validateBody(inviteUserSchema), invite);
router.post('/accept', validateBody(acceptInvitationSchema), accept);
router.post('/accept-existing', authenticate, validateBody(acceptExistingInvitationSchema), acceptExisting);
router.post('/:id/resend', authenticate, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), resend);
router.post('/:id/revoke', authenticate, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), revoke);

module.exports = router;
