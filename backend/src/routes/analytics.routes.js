const express = require('express');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const checkPermission = require('../middlewares/checkPermission');
const AppError = require('../utils/app-error');
const { validateQuery } = require('../middlewares/validate.middleware');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS: P } = require('../constants/permissions');
const { ROLE_PERMISSIONS } = require('../constants/rolePermissions');
const c = require('../controllers/analytics.controller');
const v = require('../validations/analytics.validation');

const router = express.Router();

// Platform analytics: SUPER_ADMIN only, aggregate counts of organizations and users.
router.get('/platform', authenticate, authorize(ROLES.SUPER_ADMIN), validateQuery(v.platformQuerySchema), c.platform);

router.use(authenticate, requireOrgAccess);

const requireAny = (...permissions) => (req, res, next) => {
  const held = ROLE_PERMISSIONS[req.user.role] || [];
  return permissions.some((permission) => held.includes(permission)) ? next() : next(new AppError('Forbidden', 403, 'FORBIDDEN'));
};

// Role-aware summary and personal analytics.
router.get('/overview', requireAny(P.VIEW_ANALYTICS, P.VIEW_OWN_ANALYTICS), validateQuery(v.analyticsQuerySchema), c.view('overview'));
router.get('/me', checkPermission(P.VIEW_OWN_ANALYTICS), validateQuery(v.analyticsQuerySchema), c.view('me'));

// Domain analytics: org-admin / admin (everything), hr (counts only), manager (led teams).
['tasks', 'projects', 'people', 'teams', 'meetings', 'assets'].forEach((type) => {
  router.get(`/${type}`, checkPermission(P.VIEW_ANALYTICS), validateQuery(v.analyticsQuerySchema), c.view(type));
});

router.get('/reports/:type', checkPermission(P.VIEW_ANALYTICS), validateQuery(v.reportQuerySchema), c.report);
router.get('/reports/:type/export', checkPermission(P.VIEW_ANALYTICS), validateQuery(v.exportQuerySchema), c.exportCsv);

module.exports = router;
