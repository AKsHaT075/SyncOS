const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const AppError = require('../utils/app-error');

// Keys are generated server-side (`<orgId>/<uuid>`); this pattern is a
// second line of defence so a bad key can never address anything outside the
// storage root (no dots, no leading slash, no empty segments).
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/;

/**
 * Local-disk implementation of the storage interface:
 *   put(key, sourcePath) · copy(srcKey, destKey) · createReadStream(key)
 *   stat(key) · remove(key)
 * A cloud provider (S3/GCS) only has to implement the same five methods.
 */
class LocalStorageProvider {
  constructor({ root }) {
    this.root = path.resolve(root);
  }

  resolve(key) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new AppError('Invalid storage key', 500, 'STORAGE_KEY_INVALID');
    }
    const absolute = path.resolve(this.root, key);
    if (!absolute.startsWith(this.root + path.sep)) {
      throw new AppError('Invalid storage key', 500, 'STORAGE_KEY_INVALID');
    }
    return absolute;
  }

  /** Moves a (temp) file into storage under `key`. */
  async put(key, sourcePath) {
    const destination = this.resolve(key);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fsp.rename(sourcePath, destination);
    } catch (error) {
      if (error.code !== 'EXDEV') {
        throw error;
      }
      await fsp.copyFile(sourcePath, destination);
      await fsp.unlink(sourcePath).catch(() => {});
    }
  }

  async copy(sourceKey, destinationKey) {
    const destination = this.resolve(destinationKey);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(this.resolve(sourceKey), destination);
  }

  createReadStream(key) {
    return fs.createReadStream(this.resolve(key));
  }

  async stat(key) {
    try {
      const stats = await fsp.stat(this.resolve(key));
      return { size: stats.size };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /** Idempotent: removing a missing object is not an error. */
  async remove(key) {
    try {
      await fsp.unlink(this.resolve(key));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

module.exports = LocalStorageProvider;
