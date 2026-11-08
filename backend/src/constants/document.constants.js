const env = require('../config/env');
const { ROLES } = require('./roles');

const DOCUMENT_VISIBILITY = Object.freeze({
  PRIVATE: 'private',
  TEAM: 'team',
  PROJECT: 'project',
  ORGANIZATION: 'organization',
});

const SHARE_PERMISSIONS = Object.freeze({
  VIEWER: 'viewer',
  EDITOR: 'editor',
});

const DOCUMENT_CATEGORIES = Object.freeze({
  PDF: 'pdf',
  WORD: 'word',
  EXCEL: 'excel',
  POWERPOINT: 'powerpoint',
  TEXT: 'text',
  CSV: 'csv',
  IMAGE: 'image',
  ARCHIVE: 'archive',
});

const OOXML_MIMES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * Single source of truth for what may be uploaded. `mime` is the canonical
 * type WE store and serve; `clientMimes` are the values a browser is allowed
 * to claim for that extension. The claim is only a consistency check — the
 * file's bytes are verified against `signature` (see utils/fileValidation).
 */
const ALLOWED_FILE_TYPES = Object.freeze({
  pdf: { mime: 'application/pdf', clientMimes: ['application/pdf'], category: DOCUMENT_CATEGORIES.PDF, signature: 'pdf', inline: true },
  doc: { mime: 'application/msword', clientMimes: ['application/msword'], category: DOCUMENT_CATEGORIES.WORD, signature: 'ole' },
  docx: { mime: OOXML_MIMES.docx, clientMimes: [OOXML_MIMES.docx], category: DOCUMENT_CATEGORIES.WORD, signature: 'ooxml', ooxmlDir: 'word/' },
  xls: { mime: 'application/vnd.ms-excel', clientMimes: ['application/vnd.ms-excel'], category: DOCUMENT_CATEGORIES.EXCEL, signature: 'ole' },
  xlsx: { mime: OOXML_MIMES.xlsx, clientMimes: [OOXML_MIMES.xlsx], category: DOCUMENT_CATEGORIES.EXCEL, signature: 'ooxml', ooxmlDir: 'xl/' },
  ppt: { mime: 'application/vnd.ms-powerpoint', clientMimes: ['application/vnd.ms-powerpoint'], category: DOCUMENT_CATEGORIES.POWERPOINT, signature: 'ole' },
  pptx: { mime: OOXML_MIMES.pptx, clientMimes: [OOXML_MIMES.pptx], category: DOCUMENT_CATEGORIES.POWERPOINT, signature: 'ooxml', ooxmlDir: 'ppt/' },
  txt: { mime: 'text/plain', clientMimes: ['text/plain'], category: DOCUMENT_CATEGORIES.TEXT, signature: 'text', inline: true },
  // Windows frequently labels .csv as application/vnd.ms-excel.
  csv: { mime: 'text/csv', clientMimes: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'], category: DOCUMENT_CATEGORIES.CSV, signature: 'text' },
  png: { mime: 'image/png', clientMimes: ['image/png'], category: DOCUMENT_CATEGORIES.IMAGE, signature: 'png', inline: true },
  jpg: { mime: 'image/jpeg', clientMimes: ['image/jpeg', 'image/jpg', 'image/pjpeg'], category: DOCUMENT_CATEGORIES.IMAGE, signature: 'jpeg', inline: true },
  jpeg: { mime: 'image/jpeg', clientMimes: ['image/jpeg', 'image/jpg', 'image/pjpeg'], category: DOCUMENT_CATEGORIES.IMAGE, signature: 'jpeg', inline: true },
  zip: { mime: 'application/zip', clientMimes: ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'], category: DOCUMENT_CATEGORIES.ARCHIVE, signature: 'zip' },
});

// Browsers sometimes send this when they cannot identify a type; the byte
// signature check still decides.
const GENERIC_CLIENT_MIMES = Object.freeze(['application/octet-stream', '']);

const DOCUMENT_MAX_FILE_SIZE_BYTES = Math.max(1, env.DOCUMENT_MAX_FILE_SIZE_MB) * 1024 * 1024;

const MAX_FOLDER_DEPTH = 10;
const MAX_FILE_NAME_LENGTH = 180;
const MAX_FOLDER_NAME_LENGTH = 120;

/**
 * Organization policy: who may publish a document to the whole organization.
 * Employees can still use private / team / project visibility.
 */
const ORG_WIDE_PUBLISH_ROLES = Object.freeze([ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR, ROLES.MANAGER]);

const DOCUMENT_ADMIN_ROLES = Object.freeze([ROLES.ORG_ADMIN, ROLES.ADMIN]);

module.exports = {
  ALLOWED_FILE_TYPES,
  DOCUMENT_ADMIN_ROLES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_MAX_FILE_SIZE_BYTES,
  DOCUMENT_VISIBILITY,
  GENERIC_CLIENT_MIMES,
  MAX_FILE_NAME_LENGTH,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_LENGTH,
  ORG_WIDE_PUBLISH_ROLES,
  SHARE_PERMISSIONS,
};
