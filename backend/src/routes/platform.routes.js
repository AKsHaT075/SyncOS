const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const { ROLES } = require('../constants/roles');
const { getOne, list, reactivate, suspend, updateFlags, updatePlan } = require('../controllers/platform.controller');
const {
  listOrganizationsQuerySchema,
  suspendOrganizationSchema,
  updateFeatureFlagsSchema,
  updatePlanSchema,
} = require('../validations/platform.validation');

const router = express.Router();

router.use(authenticate, authorize(ROLES.SUPER_ADMIN));

router.get('/', validateQuery(listOrganizationsQuerySchema), list);
router.get('/:id', getOne);
router.patch('/:id/plan', validateBody(updatePlanSchema), updatePlan);
router.post('/:id/suspend', validateBody(suspendOrganizationSchema), suspend);
router.post('/:id/reactivate', reactivate);
router.patch('/:id/feature-flags', validateBody(updateFeatureFlagsSchema), updateFlags);

module.exports = router;
