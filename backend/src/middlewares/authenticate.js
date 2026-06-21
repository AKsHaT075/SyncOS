const { authenticate, optionalAuthenticate } = require('./auth.middleware');

module.exports = {
  authenticate,
  optionalAuthenticate,
};
