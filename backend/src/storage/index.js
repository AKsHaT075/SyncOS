const crypto = require('crypto');
const env = require('../config/env');
const LocalStorageProvider = require('./local.provider');

let provider = null;

function getStorage() {
  if (!provider) {
    if (env.STORAGE_DRIVER !== 'local') {
      throw new Error(`Unsupported STORAGE_DRIVER "${env.STORAGE_DRIVER}" (only "local" is implemented)`);
    }
    provider = new LocalStorageProvider({ root: env.STORAGE_LOCAL_ROOT });
  }
  return provider;
}

/** Unique, unguessable, extension-free storage key scoped under the org. */
function generateStorageKey(organizationId) {
  return `${organizationId.toString()}/${crypto.randomUUID()}`;
}

module.exports = { generateStorageKey, getStorage };
