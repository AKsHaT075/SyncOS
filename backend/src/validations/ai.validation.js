const { z } = require('zod');
const { AI_QUOTA_BOUNDS } = require('../constants/ai.constants');

const quota = z.number().int().min(AI_QUOTA_BOUNDS.min).max(AI_QUOTA_BOUNDS.max);

const updateSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    // Required (and must equal the current disclosure version) when switching AI on.
    acceptDisclosureVersion: z.string().trim().min(1).max(60).optional(),
    // Live organizational data (Phase 8). Switching it on needs AI on and its own disclosure accepted.
    liveDataEnabled: z.boolean().optional(),
    acceptLiveDataDisclosureVersion: z.string().trim().min(1).max(60).optional(),
    // null resets to the platform default.
    quotas: z
      .object({
        userDailyTokens: quota.nullable().optional(),
        orgMonthlyTokens: quota.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.enabled !== undefined || value.liveDataEnabled !== undefined || value.quotas !== undefined, { message: 'Nothing to update' });

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const usageQuerySchema = z.object({ from: dateOnly.optional(), to: dateOnly.optional() }).strict();

// What Python may send when it asks Node to run a tool. Strict; identity is never part of it (it comes from the token).
const toolExecuteSchema = z
  .object({
    callId: z.string().trim().min(1).max(128),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const { INGESTION_STATUS, REASON_MESSAGES } = require('../constants/ingestion.constants');

const ingestionJobsQuerySchema = z
  .object({
    status: z.enum(Object.values(INGESTION_STATUS)).optional(),
    reason: z.enum(Object.keys(REASON_MESSAGES)).optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const { EMBEDDING_KIND, EMBEDDING_STATUS, REASON_MESSAGES: EMBEDDING_REASONS } = require('../constants/embedding.constants');

const embeddingJobsQuerySchema = z
  .object({
    status: z.enum(Object.values(EMBEDDING_STATUS)).optional(),
    kind: z.enum(Object.values(EMBEDDING_KIND)).optional(),
    reason: z.enum(Object.keys(EMBEDDING_REASONS)).optional(),
    spaceId: z.string().regex(/^[a-f0-9]{12}$/).optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const env = require('../config/env');

// What Python may send to ask which retrieved chunks the user can use. Identifiers and hashes only; identity is never part of it.
const knowledgeAuthorizeSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            documentId: z.string().regex(/^[a-f0-9]{24}$/i),
            version: z.number().int().min(1).max(100000),
            chunkIndex: z.number().int().min(0).max(100000),
            textHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(env.AI_RAG_AUTHORIZE_MAX_CANDIDATES),
  })
  .strict();

// A question and nothing else: the organization, the user and the index come from the session, never from the body.
// Emergency switches (super-admin). A fixed reason CODE only: no free text ever reaches the audit log.
const platformControlSchema = z
  .object({ aiDisabled: z.boolean().optional(), liveToolsDisabled: z.boolean().optional(), reason: z.enum(['incident', 'maintenance', 'security', 'other']).optional() })
  .strict()
  .refine((v) => v.aiDisabled !== undefined || v.liveToolsDisabled !== undefined, { message: 'Nothing to change' });

const askSchema = z.object({ question: z.string().trim().min(1).max(env.AI_RAG_MAX_QUESTION_CHARS) }).strict();

const cursorField = z.string().min(1).max(300).optional();
const titleField = z.string().trim().min(1).max(120);
const createConversationSchema = z.object({ title: titleField.optional() }).strict();
const updateConversationSchema = z
  .object({ title: titleField.optional(), archived: z.boolean().optional() })
  .strict()
  .refine((v) => v.title !== undefined || v.archived !== undefined, { message: 'Nothing to update' });
const sendMessageSchema = z.object({ content: z.string().trim().min(1).max(env.AI_RAG_MAX_QUESTION_CHARS) }).strict();
const listConversationsQuerySchema = z.object({ status: z.enum(['active', 'archived']).optional(), limit: z.coerce.number().int().min(1).max(50).optional(), cursor: cursorField }).strict();
const listMessagesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: cursorField }).strict();

module.exports = { platformControlSchema, createConversationSchema, listConversationsQuerySchema, listMessagesQuerySchema, sendMessageSchema, updateConversationSchema, askSchema, knowledgeAuthorizeSchema, embeddingJobsQuerySchema, ingestionJobsQuerySchema, toolExecuteSchema, updateSettingsSchema, usageQuerySchema };
