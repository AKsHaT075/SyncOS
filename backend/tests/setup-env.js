process.env.NODE_ENV = 'test';
// One database PER TEST FILE (this setup file runs once per file). Files drop their database when they
// finish; sharing a single name let the next file start creating collections while the previous drop was
// still completing, which showed up as sporadic 401s / whole-file failures at file boundaries.
process.env.MONGO_URI = process.env.TEST_MONGO_URI
  || `mongodb://127.0.0.1:27017/syncos_test_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Keep test uploads out of the real uploads/ directory.
const os = require('os');
const path = require('path');

process.env.STORAGE_LOCAL_ROOT = process.env.STORAGE_LOCAL_ROOT_TEST
  || path.join(os.tmpdir(), 'syncos-test-storage');
process.env.UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'syncos-test-upload-tmp');
process.env.DOCUMENT_MAX_FILE_SIZE_MB = '1';

// Isolate Redis keys/channels from a running dev server.
process.env.EMAIL_QUEUE_PREFIX = 'test:email';
process.env.NOTIFICATION_CHANNEL_PREFIX = 'test:notif';
