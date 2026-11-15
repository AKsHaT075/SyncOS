const express = require('express');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const checkPermission = require('../middlewares/checkPermission');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS: P } = require('../constants/permissions');
const c = require('../controllers/ai.controller');
const v = require('../validations/ai.validation');

const router = express.Router();

// Platform provider health: SUPER_ADMIN only. Aggregate / configuration data, never tenant content.
router.get('/platform/control', authenticate, authorize(ROLES.SUPER_ADMIN), c.platformControl);
router.put('/platform/control', authenticate, authorize(ROLES.SUPER_ADMIN), validateBody(v.platformControlSchema), c.updatePlatformControl);
router.get('/platform/status', authenticate, authorize(ROLES.SUPER_ADMIN), c.platformStatus);
router.get('/platform/usage', authenticate, authorize(ROLES.SUPER_ADMIN), validateQuery(v.usageQuerySchema), c.platformUsage);

// The embedding SPACE is platform-wide, so inspecting it globally and migrating it are super-admin operations.
router.get('/platform/embedding', authenticate, authorize(ROLES.SUPER_ADMIN), c.platformEmbedding);
router.post('/platform/embedding/migration/promote', authenticate, authorize(ROLES.SUPER_ADMIN), c.embeddingPromote);
router.post('/platform/embedding/migration/abandon', authenticate, authorize(ROLES.SUPER_ADMIN), c.embeddingAbandon);
router.post('/platform/embedding/migration/start', authenticate, authorize(ROLES.SUPER_ADMIN), c.embeddingStart);

router.use(authenticate, requireOrgAccess);

// Ask a question of the organization's documents (retrieval-augmented, permission-aware). JSON, or SSE with `Accept: text/event-stream`.
router.post('/ask', checkPermission(P.USE_AI), validateBody(v.askSchema), c.ask);

// Conversations. Private to their owner: there is deliberately NO organization-wide or admin route to read one.
router.post('/conversations', checkPermission(P.USE_AI), validateBody(v.createConversationSchema), c.createConversation);
router.get('/conversations', checkPermission(P.USE_AI), validateQuery(v.listConversationsQuerySchema), c.listConversations);
router.get('/conversations/:id', checkPermission(P.USE_AI), c.getConversation);
router.patch('/conversations/:id', checkPermission(P.USE_AI), validateBody(v.updateConversationSchema), c.updateConversation);
router.delete('/conversations/:id', checkPermission(P.USE_AI), c.deleteConversation);
router.get('/conversations/:id/messages', checkPermission(P.USE_AI), validateQuery(v.listMessagesQuerySchema), c.listMessages);
router.post('/conversations/:id/messages', checkPermission(P.USE_AI), validateBody(v.sendMessageSchema), c.sendMessage);

// Anyone allowed to use AI (not guests, not super-admin) can ask whether it is ready.
router.get('/status', checkPermission(P.USE_AI), c.status);

// Usage: members see their own; organization-wide usage needs VIEW_AI_USAGE (org-admin / admin).
router.get('/usage/me', checkPermission(P.USE_AI), validateQuery(v.usageQuerySchema), c.myUsage);
router.get('/usage', checkPermission(P.VIEW_AI_USAGE), validateQuery(v.usageQuerySchema), c.orgUsage);

// Organization AI administration.
router.get('/disclosure', checkPermission(P.MANAGE_AI), c.disclosure);
router.get('/settings', checkPermission(P.MANAGE_AI), c.getSettings);
router.put('/settings', checkPermission(P.MANAGE_AI), validateBody(v.updateSettingsSchema), c.updateSettings);

// Document ingestion administration. Ids and statuses only - never document names or text.
router.get('/knowledge/ingestion', checkPermission(P.MANAGE_AI_KNOWLEDGE), c.ingestionOverview);
router.get('/knowledge/ingestion/jobs', checkPermission(P.MANAGE_AI_KNOWLEDGE), validateQuery(v.ingestionJobsQuerySchema), c.ingestionJobs);
router.post('/knowledge/ingestion/jobs/:id/retry', checkPermission(P.MANAGE_AI_KNOWLEDGE), c.ingestionRetry);
router.post('/knowledge/ingestion/reconcile', checkPermission(P.MANAGE_AI_KNOWLEDGE), c.ingestionReconcile);

// Embeddings and the vector index, tenant-scoped. Ids, counts and statuses only.
const K = checkPermission(P.MANAGE_AI_KNOWLEDGE);
router.get('/knowledge/embedding', K, c.embeddingOverview);
router.get('/knowledge/embedding/jobs', K, validateQuery(v.embeddingJobsQuerySchema), c.embeddingJobs);
router.post('/knowledge/embedding/jobs/:id/retry', K, c.embeddingRetry);
router.post('/knowledge/embedding/reconcile', K, c.embeddingReconcile);
router.post('/knowledge/embedding/verify', K, c.embeddingVerify);

module.exports = router;
