const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const checkPermission = require('../middlewares/checkPermission');
const { PERMISSIONS } = require('../constants/permissions');
const {
  addMember,
  create,
  getById,
  list,
  memberCandidates,
  my,
  remove,
  removeMember,
  setManager,
  update,
} = require('../controllers/team.controller');
const {
  addMemberSchema,
  createTeamSchema,
  listTeamsQuerySchema,
  memberCandidatesQuerySchema,
  setManagerSchema,
  updateTeamSchema,
} = require('../validations/team.validation');

const router = express.Router();

router.use(authenticate, requireOrgAccess);

// Read is open to every logged-in user but scoped per-team in the service:
// employees and managers only see teams they belong to (or lead), while
// ORG_ADMIN / ADMIN / HR see the whole org.
router.get('/', checkPermission(PERMISSIONS.VIEW_TEAM), validateQuery(listTeamsQuerySchema), list);
router.get('/me', checkPermission(PERMISSIONS.VIEW_TEAM), my);
router.post('/', checkPermission(PERMISSIONS.CREATE_TEAM), validateBody(createTeamSchema), create);

// Team settings (name/description) and deletion stay with ORG_ADMIN / ADMIN / HR.
router.get('/:id', checkPermission(PERMISSIONS.VIEW_TEAM), getById);
router.patch('/:id', checkPermission(PERMISSIONS.UPDATE_TEAM), validateBody(updateTeamSchema), update);
router.delete('/:id', checkPermission(PERMISSIONS.DELETE_TEAM), remove);

// Membership management is gated by MANAGE_TEAM_MEMBERS (ORG_ADMIN / ADMIN /
// HR) and further scoped to the team's organization inside the service.
router.post('/:id/members', checkPermission(PERMISSIONS.MANAGE_TEAM_MEMBERS), validateBody(addMemberSchema), addMember);
router.delete('/:id/members/:memberId', checkPermission(PERMISSIONS.MANAGE_TEAM_MEMBERS), removeMember);
router.put('/:id/manager', checkPermission(PERMISSIONS.MANAGE_TEAM_MEMBERS), validateBody(setManagerSchema), setManager);
router.get(
  '/:id/member-candidates',
  checkPermission(PERMISSIONS.MANAGE_TEAM_MEMBERS),
  validateQuery(memberCandidatesQuerySchema),
  memberCandidates,
);

module.exports = router;
