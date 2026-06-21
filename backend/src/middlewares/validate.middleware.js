const AppError = require('../utils/app-error');

function validateBody(schema) {
  return function validationMiddleware(req, res, next) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', result.error.flatten());
    }

    req.body = result.data;
    return next();
  };
}

function validateQuery(schema) {
  return function validationMiddleware(req, res, next) {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', result.error.flatten());
    }

    req.query = result.data;
    return next();
  };
}

module.exports = { validateBody, validateQuery };
