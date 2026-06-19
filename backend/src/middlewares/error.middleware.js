const AppError = require('../utils/app-error');

function notFoundHandler(req, res, next) {
  next(new AppError(`Route not found: ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND'));
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_SERVER_ERROR';
  const message = err.message || 'Internal Server Error';

  if (res.headersSent) {
    return next(err);
  }

  res.status(statusCode).json({
    code,
    details: err.details || null,
    message: statusCode === 500 ? 'Internal Server Error' : message,
    success: false,
    ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
}

module.exports = {
  errorHandler,
  notFoundHandler,
};