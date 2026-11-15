const express = require('express');
const { validateBody } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const { ROLES } = require('../constants/roles');
const { create, listMine, update, usage } = require('../controllers/organization.controller');
const { createOrganizationSchema, updateOrganizationSchema } = require('../validations/organization.validation');

const router = express.Router();

router.get('/me', authenticate, listMine);
router.patch('/me', authenticate, requireOrgAccess, authorize(ROLES.ORG_ADMIN), validateBody(updateOrganizationSchema), update);
router.get('/me/usage', authenticate, requireOrgAccess, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), usage);
router.post('/', authenticate, validateBody(createOrganizationSchema), create);

module.exports = router;
