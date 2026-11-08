const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const checkPermission = require('../middlewares/checkPermission');
const { PERMISSIONS } = require('../constants/permissions');
const controller = require('../controllers/calendar.controller');
const {
  calendarQuerySchema,
  createEventSchema,
  deleteEventQuerySchema,
  rsvpSchema,
  updateEventSchema,
  updatePreferencesSchema,
} = require('../validations/calendar.validation');

const router = express.Router();

// Everything is scoped to the caller's organization and re-checked per resource in the services
// (event visibility, team leadership, project management, meeting/task access). Reading needs no
// role permission — guests may read what they're allowed to see — while writing needs CREATE_EVENT.
router.use(authenticate, requireOrgAccess);

router.get('/', validateQuery(calendarQuerySchema), controller.list);

router.get('/preferences', controller.getPreferences);
router.put('/preferences', validateBody(updatePreferencesSchema), controller.updatePreferences);

router.post('/events', checkPermission(PERMISSIONS.CREATE_EVENT), validateBody(createEventSchema), controller.create);
router.get('/events/:id', controller.getById);
router.patch('/events/:id', checkPermission(PERMISSIONS.CREATE_EVENT), validateBody(updateEventSchema), controller.update);
router.delete('/events/:id', checkPermission(PERMISSIONS.CREATE_EVENT), validateQuery(deleteEventQuerySchema), controller.remove);
router.post('/events/:id/rsvp', validateBody(rsvpSchema), controller.rsvp);

module.exports = router;
