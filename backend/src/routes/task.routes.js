const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const { uploadSingleTaskAttachment, uploadTaskAttachments } = require('../middlewares/upload');
const {
  activity,
  archive,
  create,
  downloadAttachment,
  getById,
  list,
  remove,
  removeAttachmentHandler,
  review,
  submit,
  unarchive,
  update,
  uploadAttachment,
} = require('../controllers/task.controller');
const {
  activityQuerySchema,
  createTaskSchema,
  listTasksQuerySchema,
  reviewTaskSchema,
  submitForReviewSchema,
  updateTaskSchema,
} = require('../validations/task.validation');

// Mounted at /projects/:projectId/tasks — mergeParams so req.params.projectId
// (bound by the parent mount) is visible here alongside this router's own
// :id (task id). Every permission decision (who can create/view/manage/
// approve) is project-role-aware, so it happens inside task.service.js, not
// via a coarse route-level checkPermission — see taskAccess.js.
const router = express.Router({ mergeParams: true });

router.use(authenticate, requireOrgAccess);

router.get('/', validateQuery(listTasksQuerySchema), list);
router.post('/', validateBody(createTaskSchema), create);

router.get('/:id', getById);
router.patch('/:id', validateBody(updateTaskSchema), update);
router.delete('/:id', remove);

router.post('/:id/archive', archive);
router.post('/:id/unarchive', unarchive);
router.post('/:id/submit', uploadTaskAttachments, validateBody(submitForReviewSchema), submit);
router.post('/:id/review', validateBody(reviewTaskSchema), review);

router.get('/:id/activity', validateQuery(activityQuerySchema), activity);

router.post('/:id/attachments', uploadSingleTaskAttachment, uploadAttachment);
router.get('/:id/attachments/:attachmentId/download', downloadAttachment);
router.delete('/:id/attachments/:attachmentId', removeAttachmentHandler);

module.exports = router;
