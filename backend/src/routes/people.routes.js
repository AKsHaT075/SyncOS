const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const checkPermission = require('../middlewares/checkPermission');
const { PERMISSIONS } = require('../constants/permissions');
const { forcePasswordReset, getById, list, remove, update } = require('../controllers/people.controller');
const { listPeopleQuerySchema, updatePersonSchema } = require('../validations/people.validation');

const router = express.Router();

router.use(authenticate, requireOrgAccess);

// Directory read is gated by VIEW_PEOPLE and further scoped inside the
// service (org role + team membership + activation status) so a manager
// only ever sees their own team and a guest only sees public fields.
router.get('/', checkPermission(PERMISSIONS.VIEW_PEOPLE), validateQuery(listPeopleQuerySchema), list);
router.get('/:id', checkPermission(PERMISSIONS.VIEW_PEOPLE), getById);

// Profile edits (skills/blocked/role/team) stay with MANAGE_USERS
// (ORG_ADMIN / ADMIN / HR), further gated by canManageUsers — and, for role
// changes and org-blocking, restricted further to ORG_ADMIN/ADMIN — inside
// the service.
router.patch('/:id', checkPermission(PERMISSIONS.MANAGE_USERS), validateBody(updatePersonSchema), update);

// Destructive/security actions: service-layer restricts these to
// ORG_ADMIN/ADMIN and blocks self-targeting.
router.post('/:id/force-password-reset', checkPermission(PERMISSIONS.MANAGE_USERS), forcePasswordReset);
router.delete('/:id', checkPermission(PERMISSIONS.MANAGE_USERS), remove);

module.exports = router;
