const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const controller = require('../controllers/notification.controller');
const {
  listNotificationsQuerySchema,
  markAllReadSchema,
  updatePreferencesSchema,
} = require('../validations/notification.validation');

const router = express.Router();

// Notifications are personal: no role permission is needed, but every route
// requires a signed-in, non-blocked member. Services scope every query to
// { recipient: req.user, organization: req.user.organization }, so another
// user's notification id is indistinguishable from a nonexistent one (404).
// There is deliberately no create endpoint — only server-side events create them.
router.use(authenticate, requireOrgAccess);

router.get('/', validateQuery(listNotificationsQuerySchema), controller.list);
router.get('/stream', controller.stream);
router.get('/unread-count', controller.unreadCount);
router.get('/preferences', controller.getPreferences);
router.put('/preferences', validateBody(updatePreferencesSchema), controller.updatePreferences);
router.post('/read-all', validateBody(markAllReadSchema), controller.markAllRead);
router.post('/:id/read', controller.markRead);
router.delete('/:id', controller.dismiss);

module.exports = router;
