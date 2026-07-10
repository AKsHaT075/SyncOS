const RESOURCE_MAX_SIZE_BYTES = 20 * 1024 * 1024;

const RESOURCE_ALLOWED_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'application/zip',
]);

module.exports = {
  RESOURCE_MAX_SIZE_BYTES,
  RESOURCE_ALLOWED_MIME_TYPES,
};
