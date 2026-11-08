const express = require('express');
const { validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const { ROLES } = require('../constants/roles');
const { list } = require('../controllers/audit.controller');
const { listAuditLogsQuerySchema } = require('../validations/audit.validation');

const router = express.Router();

router.get('/', authenticate, requireOrgAccess, authorize(ROLES.ORG_ADMIN, ROLES.ADMIN), validateQuery(listAuditLogsQuerySchema), list);

module.exports = router;
