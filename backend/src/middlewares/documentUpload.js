const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const env = require('../config/env');
const AppError = require('../utils/app-error');
const { ALLOWED_FILE_TYPES, DOCUMENT_MAX_FILE_SIZE_BYTES } = require('../constants/document.constants');
const { decodeOriginalName, getExtension } = require('../utils/fileValidation');

const TMP_DIR = path.resolve(env.UPLOAD_TMP_DIR);
fs.mkdirSync(TMP_DIR, { recursive: true });

const uploader = multer({
  // The temp name is random and extension-less: the client's filename never
  // touches the filesystem path.
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
  }),
  fileFilter(req, file, cb) {
    // Cheap early rejection before any bytes are written; the real check
    // (size + content signature) happens in inspectUpload().
    if (!ALLOWED_FILE_TYPES[getExtension(decodeOriginalName(file.originalname))]) {
      return cb(new AppError('This file type is not allowed', 400, 'UNSUPPORTED_FILE_TYPE'));
    }
    return cb(null, true);
  },
  limits: { fileSize: DOCUMENT_MAX_FILE_SIZE_BYTES, files: 1, fields: 20, fieldSize: 4 * 1024 },
});

// multer errors bypass the Express error chain unless re-thrown as AppError.
const uploadDocumentFile = (req, res, next) => {
  uploader.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          new AppError(
            `File is too large (max ${Math.round(DOCUMENT_MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB)`,
            413,
            'FILE_TOO_LARGE',
          ),
        );
      }
      return next(new AppError(err.message, 400, 'UPLOAD_ERROR'));
    }
    return next(err);
  });
};

async function removeTempFile(file) {
  if (file?.path) {
    await fs.promises.unlink(file.path).catch(() => {});
  }
}

module.exports = { removeTempFile, uploadDocumentFile };
