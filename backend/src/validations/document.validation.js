const { z } = require('zod');
const {
  DOCUMENT_CATEGORIES,
  DOCUMENT_VISIBILITY,
  MAX_FOLDER_NAME_LENGTH,
  SHARE_PERMISSIONS,
} = require('../constants/document.constants');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

// Multipart forms send '' for untouched inputs; treat that as "not provided".
const emptyToUndefined = (value) => (value === '' || value === null ? undefined : value);
const optionalObjectId = z.preprocess(emptyToUndefined, objectId.optional());
const optionalText = (max) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const visibilityEnum = z.enum(Object.values(DOCUMENT_VISIBILITY));

const visibilityTargetRules = (data, ctx) => {
  if (data.visibility === DOCUMENT_VISIBILITY.TEAM && !data.teamId) {
    ctx.addIssue({ code: 'custom', path: ['teamId'], message: 'teamId is required for team visibility' });
  }
  if (data.visibility === DOCUMENT_VISIBILITY.PROJECT && !data.projectId) {
    ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'projectId is required for project visibility' });
  }
};

const createDocumentSchema = z
  .object({
    name: optionalText(180),
    description: optionalText(1000),
    folderId: optionalObjectId,
    visibility: z.preprocess(emptyToUndefined, visibilityEnum.default(DOCUMENT_VISIBILITY.PRIVATE)),
    teamId: optionalObjectId,
    projectId: optionalObjectId,
  })
  .superRefine(visibilityTargetRules);

const updateDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(180).optional(),
    description: z.string().trim().max(1000).optional(),
    visibility: visibilityEnum.optional(),
    teamId: objectId.optional().nullable(),
    projectId: objectId.optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'At least one field to update is required' });
    }
    if (data.visibility) {
      visibilityTargetRules(data, ctx);
    }
  });

const moveDocumentSchema = z.object({
  folderId: objectId.nullable(),
});

const listDocumentsQuerySchema = z
  .object({
    // 'root' = library root; omitted = across the whole library.
    folderId: z.union([z.literal('root'), objectId]).optional(),
    search: z.string().trim().max(120).optional(),
    category: z.enum(Object.values(DOCUMENT_CATEGORIES)).optional(),
    ownerId: objectId.optional(),
    visibility: visibilityEnum.optional(),
    scope: z.enum(['all', 'mine', 'shared']).default('all'),
    uploadedFrom: z.coerce.date().optional(),
    uploadedTo: z.coerce.date().optional(),
    sortBy: z.enum(['name', 'createdAt', 'updatedAt', 'size']).default('updatedAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(24),
  })
  .strict();

const downloadQuerySchema = z.object({
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
});

const shareSchema = z.object({
  userId: objectId,
  permission: z.enum(Object.values(SHARE_PERMISSIONS)).default(SHARE_PERMISSIONS.VIEWER),
});

const uploadVersionSchema = z.object({
  changeNote: optionalText(500),
});

const activityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const trashQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

const folderNameSchema = z.string().trim().min(1).max(MAX_FOLDER_NAME_LENGTH);

const createFolderSchema = z.object({
  name: folderNameSchema,
  parentId: objectId.nullable().optional(),
});

const updateFolderSchema = z
  .object({
    name: folderNameSchema.optional(),
    parentId: objectId.nullable().optional(),
  })
  .refine((data) => data.name !== undefined || data.parentId !== undefined, {
    message: 'At least one field to update is required',
    path: ['name'],
  });

const listFoldersQuerySchema = z.object({
  // 'root' | folder id: direct children + breadcrumb for that folder.
  parentId: z.union([z.literal('root'), objectId]).optional(),
  // all=true: every folder (for the sidebar tree).
  all: z.enum(['true', 'false']).default('false'),
});

module.exports = {
  activityQuerySchema,
  createDocumentSchema,
  createFolderSchema,
  downloadQuerySchema,
  listDocumentsQuerySchema,
  listFoldersQuerySchema,
  moveDocumentSchema,
  shareSchema,
  trashQuerySchema,
  updateDocumentSchema,
  updateFolderSchema,
  uploadVersionSchema,
};
