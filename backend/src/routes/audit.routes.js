const express = require('express');
const { validateQuery } = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const { ROLES } = require('../constants/roles');
const { list } = require('../controllers/audit.controller');
const { listAuditLogsQuerySchema } = require('../validations/audit.validation');

const router = express.Router();

router.get('/', authenticate, authorize(ROLES.ORG_ADMIN), validateQuery(listAuditLogsQuerySchema), list);

module.exports = router;
