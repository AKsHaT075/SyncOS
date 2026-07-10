const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AppError = require('../utils/app-error');
const { RESOURCE_MAX_SIZE_BYTES, RESOURCE_ALLOWED_MIME_TYPES } = require('../constants/resource.constants');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'project-resources');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOAD_ROOT);
  },
  filename(req, file, cb) {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

function fileFilter(req, file, cb) {
  if (!RESOURCE_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new AppError('This file type is not allowed', 400, 'UNSUPPORTED_FILE_TYPE'));
  }
  return cb(null, true);
}

const resourceUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: RESOURCE_MAX_SIZE_BYTES, files: 1 },
});

// multer surfaces its own errors (wrong field name, file too large) outside
// the normal Express error chain unless caught here and re-thrown as an
// AppError, so the global errorHandler can still shape the response.
function uploadSingleResource(req, res, next) {
  resourceUpload.single('file')(req, res, (err) => {
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
}

module.exports = { UPLOAD_ROOT, uploadSingleResource };
