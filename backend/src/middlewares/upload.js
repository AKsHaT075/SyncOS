const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AppError = require('../utils/app-error');
const { RESOURCE_MAX_SIZE_BYTES, RESOURCE_ALLOWED_MIME_TYPES } = require('../constants/resource.constants');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'project-resources');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const TASK_UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'task-attachments');
fs.mkdirSync(TASK_UPLOAD_ROOT, { recursive: true });

function diskStorageFor(root) {
  return multer.diskStorage({
    destination(req, file, cb) {
      cb(null, root);
    },
    filename(req, file, cb) {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    },
  });
}

function fileFilter(req, file, cb) {
  if (!RESOURCE_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new AppError('This file type is not allowed', 400, 'UNSUPPORTED_FILE_TYPE'));
  }
  return cb(null, true);
}

const resourceUpload = multer({
  storage: diskStorageFor(UPLOAD_ROOT),
  fileFilter,
  limits: { fileSize: RESOURCE_MAX_SIZE_BYTES, files: 1 },
});

// Submissions/comments may carry more than one file, so this instance
// allows up to 5 rather than the single-file project-resource limit.
const taskUpload = multer({
  storage: diskStorageFor(TASK_UPLOAD_ROOT),
  fileFilter,
  limits: { fileSize: RESOURCE_MAX_SIZE_BYTES, files: 5 },
});

// multer surfaces its own errors (wrong field name, file too large) outside
// the normal Express error chain unless caught here and re-thrown as an
// AppError, so the global errorHandler can still shape the response.
function handleMulter(instance, mode, field) {
  return function uploadHandler(req, res, next) {
    instance[mode](field, mode === 'array' ? 5 : undefined)(req, res, (err) => {
      if (!err) {
        return next();
      }

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError('File is too large (max 20MB)', 400, 'FILE_TOO_LARGE'));
        }
        return next(new AppError(err.message, 400, 'UPLOAD_ERROR'));
      }

      return next(err);
    });
  };
}

const uploadSingleResource = handleMulter(resourceUpload, 'single', 'file');
const uploadSingleTaskAttachment = handleMulter(taskUpload, 'single', 'file');
const uploadTaskAttachments = handleMulter(taskUpload, 'array', 'files');

module.exports = {
  TASK_UPLOAD_ROOT,
  UPLOAD_ROOT,
  uploadSingleResource,
  uploadSingleTaskAttachment,
  uploadTaskAttachments,
};
