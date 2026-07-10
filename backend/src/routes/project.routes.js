const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const checkPermission = require('../middlewares/checkPermission');
const { uploadSingleResource } = require('../middlewares/upload');
const { PERMISSIONS } = require('../constants/permissions');
const {
  activity,
  addProjectMember,
  archive,
  create,
  favorite,
  getById,
  list,
  memberCandidates,
  remove,
  removeProjectMember,
  restore,
  transfer,
  unfavorite,
  update,
  updateProjectMemberRole,
} = require('../controllers/project.controller');
const {
  download: downloadResource,
  list: listResources,
  remove: removeResource,
  upload: uploadResource,
} = require('../controllers/projectResource.controller');
const {
  activityQuerySchema,
  addMemberSchema,
  createProjectSchema,
  listProjectsQuerySchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateProjectSchema,
} = require('../validations/project.validation');

const router = express.Router();

router.use(authenticate);

// Read access is scoped per-project inside the service (org role + team +
// membership + visibility) rather than gated by a single coarse permission,
// so employees can see the projects they belong to.
router.get('/', validateQuery(listProjectsQuerySchema), list);
router.post('/', checkPermission(PERMISSIONS.CREATE_PROJECT), validateBody(createProjectSchema), create);

// Update/archive/restore/member-management are gated by canManageProject
// inside the service, not a coarse permission — a project Owner or
// Manager-role member may manage their project even if their org role
// (e.g. EMPLOYEE) has no blanket UPDATE_PROJECT permission.
router.get('/:id', getById);
router.patch('/:id', validateBody(updateProjectSchema), update);
router.delete('/:id', checkPermission(PERMISSIONS.DELETE_PROJECT), remove);

router.post('/:id/archive', archive);
router.post('/:id/restore', restore);
router.post('/:id/transfer-ownership', validateBody(transferOwnershipSchema), transfer);

router.post('/:id/favorite', favorite);
router.delete('/:id/favorite', unfavorite);

router.get('/:id/activity', validateQuery(activityQuerySchema), activity);

router.get('/:id/members/candidates', memberCandidates);
router.post('/:id/members', validateBody(addMemberSchema), addProjectMember);
router.patch('/:id/members/:userId', validateBody(updateMemberRoleSchema), updateProjectMemberRole);
router.delete('/:id/members/:userId', removeProjectMember);

// Resources are project-scoped file attachments (reference images/docs a
// Manager/Owner shares with the team). Upload/delete are gated by
// canManageProject inside the service, same as members management.
router.get('/:id/resources', listResources);
router.post('/:id/resources', uploadSingleResource, uploadResource);
router.get('/:id/resources/:resourceId/download', downloadResource);
router.delete('/:id/resources/:resourceId', removeResource);

module.exports = router;
