const AppError = require('../utils/app-error');

function notFoundHandler(req, res, next) {
  next(new AppError(`Route not found: ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND'));
}

/**
 * The ONE shape every HTTP error leaves the API in: { code, details, message, success:false }. A stack trace, file path, upstream error text
 * or internal id NEVER appears in a response, in any environment (a developer reads the server log instead). Unexpected failures (5xx) are
 * logged with their stack; the log line carries the method, the PATH (never the query string, headers or body, which can hold tokens)
 * and the error code, so it is useful to an operator without becoming a place where secrets collect.
 */
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_SERVER_ERROR';
  const message = err.message || 'Internal Server Error';

  if (res.headersSent) {
    return next(err);
  }

  if (statusCode >= 500) {
    console.error(`[http] ${req.method} ${req.path} -> ${statusCode} ${code}`, err.stack || err);
  }

  res.status(statusCode).json({
    code,
    details: err.details || null,
    message: statusCode === 500 ? 'Internal Server Error' : message,
    success: false,
  });
}

module.exports = {
  errorHandler,
  notFoundHandler,
};
