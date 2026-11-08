const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
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

router.get('/', authenticate, requireOrgAccess, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), validateQuery(listInvitationsQuerySchema), list);
router.post('/', authenticate, requireOrgAccess, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), validateBody(inviteUserSchema), invite);
router.post('/accept', validateBody(acceptInvitationSchema), accept);
// Not gated by requireOrgAccess: a user blocked in their current org must
// still be able to accept an invitation into a different organization.
router.post('/accept-existing', authenticate, validateBody(acceptExistingInvitationSchema), acceptExisting);
router.post('/:id/resend', authenticate, requireOrgAccess, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), resend);
router.post('/:id/revoke', authenticate, requireOrgAccess, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), revoke);

module.exports = router;
