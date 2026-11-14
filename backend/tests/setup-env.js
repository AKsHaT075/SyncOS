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

// AI: tests must never reach the Python AI service or a provider, even if a developer's .env configures them.
// dotenv does not override variables that already exist, so setting these (even to '') wins.
// Suites that need an AI engine install a fake (aiService.setEngine) or start their own local stub/service.
process.env.AI_SERVICE_URL = 'http://127.0.0.1:9';
process.env.AI_SERVICE_SIGNING_KEY = '';
process.env.AI_SERVICE_SIGNING_KEY_FILE = '';
process.env.AI_GLOBAL_ENABLED = 'true';
process.env.AI_REDIS_PREFIX = 'test:ai';
