const express = require('express');
const { z } = require('zod');
const asyncHandler = require('./utils/async-handler');
const { validateBody } = require('./middlewares/validate.middleware');
const { authorizeKnowledge, executeTool } = require('./services/ai/aiCallbacks.service');
const worker = require('./services/ai/ingestion/ingestionWorkerApi.service');
const { authenticateWorker, EMBEDDING_AUDIENCE } = require('./services/ai/ingestion/ingestionWorkerAuth');
const embeddingWorker = require('./services/ai/embedding/embeddingWorkerApi.service');
const { knowledgeAuthorizeSchema, toolExecuteSchema } = require('./validations/ai.validation');
const AppError = require('./utils/app-error');

/**
 * The INTERNAL listener, served on its own host:port (default 127.0.0.1:5002), never on the public app, so a
 * reverse proxy in front of the API cannot expose it. No cookies, no CORS, no sessions.
 *
 *   /internal/ai/tools/execute      callbacks from the AI service; callback token + live re-authorization
 *   /internal/ai/knowledge/authorize  which retrieved chunks the request's user may use (callback token, scope knowledge:authorize)
 *   /internal/ingestion/*           the Python ingestion worker; worker token (single use) + job lock token
 *   /internal/embedding/*           the Python embedding worker; same key pair, its own audience, same job-lock binding
 *
 * Every route re-authorizes independently (see aiCallbacks.service.js / ingestionWorkerApi.service.js).
 */
function bearerToken(req) {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  return scheme?.toLowerCase() === 'bearer' ? token || '' : '';
}

function notFound(req, res) {
  res.status(404).json({ success: false, code: 'ROUTE_NOT_FOUND', message: 'Not found' });
}

// Own handler (not the public one): never a stack trace, and never the text of an unexpected error,
// which could carry data a tool or an extractor just read.
function internalErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const operational = err instanceof AppError && err.isOperational;
  const status = operational ? err.statusCode : err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500;
  if (status >= 500) console.error('[ai-internal] unexpected failure:', err?.name || 'Error');
  return res.status(status).json({
    success: false,
    code: operational ? err.code : status === 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST',
    message: operational ? err.message : status === 500 ? 'Internal Server Error' : 'Bad request',
    details: operational ? err.details || null : null,
  });
}

const claimSchema = z.object({ workerId: z.string().max(80).optional(), pipelineVersion: z.string().min(1).max(20) }).strict();
const lockSchema = z.object({ lockToken: z.string().min(16).max(200) }).strict();
const resultBodySchema = z.object({ lockToken: z.string().min(16).max(200), result: z.unknown() }).strict();

function ingestionRouter() {
  const router = express.Router();
  // Authenticate BEFORE reading any body, so an unauthenticated caller cannot make us buffer megabytes.
  router.use(
    asyncHandler(async (req, res, next) => {
      req.worker = await authenticateWorker(req.headers.authorization);
      next();
    }),
  );
  const small = express.json({ limit: '16kb' });
  const large = express.json({ limit: '12mb' }); // a result carries every chunk of one document

  router.post('/claim', small, validateBody(claimSchema), asyncHandler(async (req, res) => {
    // The identity recorded on the job is the AUTHENTICATED worker id, not whatever the body says.
    res.json({ success: true, ...(await worker.claimJob({ workerId: req.worker.workerId, pipelineVersion: req.body.pipelineVersion })) });
  }));

  router.post('/jobs/:id/heartbeat', small, validateBody(lockSchema), asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await worker.heartbeat({ jobId: req.params.id, lockToken: req.body.lockToken })) });
  }));

  router.get('/jobs/:id/content', asyncHandler(async (req, res) => {
    const { stream, size } = await worker.openContent({ jobId: req.params.id, lockToken: String(req.headers['x-lock-token'] || '') });
    res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'no-store' });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }));

  router.post('/jobs/:id/result', large, validateBody(resultBodySchema), asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await worker.submitResult({ jobId: req.params.id, lockToken: req.body.lockToken, result: req.body.result })) });
  }));

  return router;
}

const embeddingClaimSchema = z.object({ spaceId: z.string().regex(/^[a-f0-9]{12}$/), ingestionPipeline: z.string().min(1).max(20) }).strict();
const embeddingChunksQuery = z.object({ after: z.coerce.number().int().min(-1).max(100000).default(-1), limit: z.coerce.number().int().min(1).max(200).default(64) });

/** Embedding worker: its OWN audience on the same worker key pair, so an ingestion token cannot be used here (or vice versa). */
function embeddingRouter() {
  const router = express.Router();
  router.use(
    asyncHandler(async (req, res, next) => {
      req.worker = await authenticateWorker(req.headers.authorization, EMBEDDING_AUDIENCE);
      next();
    }),
  );
  const small = express.json({ limit: '16kb' });

  router.post('/claim', small, validateBody(embeddingClaimSchema), asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await embeddingWorker.claimJob({ workerId: req.worker.workerId, spaceId: req.body.spaceId, ingestionPipeline: req.body.ingestionPipeline })) });
  }));

  router.post('/jobs/:id/heartbeat', small, validateBody(lockSchema), asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await embeddingWorker.heartbeat({ jobId: req.params.id, lockToken: req.body.lockToken })) });
  }));

  router.get('/jobs/:id/chunks', asyncHandler(async (req, res) => {
    const q = embeddingChunksQuery.safeParse(req.query);
    if (!q.success) throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    const page = await embeddingWorker.chunksPage({ jobId: req.params.id, lockToken: String(req.headers['x-lock-token'] || ''), after: q.data.after, limit: q.data.limit });
    res.set('Cache-Control', 'no-store').json({ success: true, ...page });
  }));

  router.post('/jobs/:id/result', small, validateBody(resultBodySchema), asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await embeddingWorker.submitResult({ jobId: req.params.id, lockToken: req.body.lockToken, result: req.body.result })) });
  }));

  return router;
}

function createInternalApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use('/internal/ingestion', ingestionRouter());
  app.use('/internal/embedding', embeddingRouter());

  app.post(
    '/internal/ai/tools/execute',
    express.json({ limit: '256kb' }),
    validateBody(toolExecuteSchema),
    asyncHandler(async (req, res) => {
      const token = bearerToken(req);
      if (!token) throw new AppError('Unauthorized', 401, 'AI_CALLBACK_UNAUTHORIZED');
      // Python gave up (its own request was cancelled, or it timed out): stop the query instead of finishing work nobody will read.
      const gone = new AbortController();
      res.on('close', () => { if (!res.writableEnded) gone.abort(); });
      const { result } = await executeTool({ token, name: req.body.name, arguments: req.body.arguments, callId: req.body.callId, signal: gone.signal, req });
      res.json({ success: true, callId: req.body.callId, result });
    }),
  );

  // Python asks which retrieved chunks this request's user may use (Phase 5). Callback token, never a worker token.
  app.post(
    '/internal/ai/knowledge/authorize',
    express.json({ limit: '64kb' }),
    validateBody(knowledgeAuthorizeSchema),
    asyncHandler(async (req, res) => {
      const token = bearerToken(req);
      if (!token) throw new AppError('Unauthorized', 401, 'AI_CALLBACK_UNAUTHORIZED');
      const { items, rejected } = await authorizeKnowledge({ token, candidates: req.body.candidates });
      res.set('Cache-Control', 'no-store').json({ success: true, items, rejected });
    }),
  );

  app.use(notFound);
  app.use(internalErrorHandler);
  return app;
}

module.exports = { createInternalApp };
