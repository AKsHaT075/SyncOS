/**
 * STANDALONE isolated end-to-end server (Phase 8 Step 8) for the real-browser and real-Groq runs. NOT part of the product:
 *   node tests/e2e/e2eServer.js <infoFile>
 * Starts, all on throw-away resources: an isolated MongoDB database (syncos_e2e_*), the `e2e:` Redis prefixes, the REAL Node API (own port,
 * never 5001) + internal listener, the REAL Python service, and a controllable fake Groq (unless E2E_REAL_GROQ=1, in which case Python reads
 * the key from the gitignored ai/.env through a shell child: this process never holds it). Live tools are switched on ONLY here, through the real
 * AI_LIVE_TOOLS_ENABLED flag, after an isolation check (an isolated database name and Redis prefix). On SIGTERM it drops its database and Redis keys.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const suffix = `${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
const PORTS = { api: Number(process.env.E2E_API_PORT || 5101), internal: Number(process.env.E2E_INTERNAL_PORT || 5103), groqControl: Number(process.env.E2E_GROQ_PORT || 8102), python: Number(process.env.E2E_PYTHON_PORT || 8101) };
process.env.MONGO_URI = `mongodb://127.0.0.1:27017/syncos_e2e_${suffix}`; // set BEFORE anything loads .env (dotenv never overrides): the dev database is never touched
process.env.AI_REDIS_PREFIX = 'e2e:ai';
process.env.EMAIL_QUEUE_PREFIX = 'e2e:email';
process.env.NOTIFICATION_CHANNEL_PREFIX = 'e2e:notif';
process.env.PORT = String(PORTS.api);
process.env.AI_INTERNAL_PORT = String(PORTS.internal);
process.env.CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:3111';
process.env.AI_GLOBAL_ENABLED = 'true';
process.env.NODE_ENV = 'development';
process.env.STORAGE_LOCAL_ROOT = path.join(require('os').tmpdir(), `syncos-e2e-storage-${suffix}`);

process.env.AI_LIVE_TOOLS_ENABLED = 'true'; // the REAL activation flag, in THIS isolated process only (the database and Redis names above were set first)
require('./lib/activation').assertIsolated();

const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectMongo } = require('../../src/config/db');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { createApp } = require('../../src/app');
const { createInternalApp } = require('../../src/internalApp');
const { registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const User = require('../../src/models/User');
const { createKeyPair } = require('../helpers/stubAiService');
const { createFakeGroq } = require('./lib/fakeGroq');
const { startPython } = require('./lib/pythonService');
const { seedFixtures } = require('./lib/fixtures');

const PASSWORD = 'E2e-Pass-123!';

async function main() {
  const infoFile = process.argv[2];
  if (!/\/syncos_e2e_/.test(env.MONGO_URI)) throw new Error('refusing to start: not an isolated database');
  registerLiveDataTools();
  await connectMongo();
  await connectRedis();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const makeUser = (org, key, role, over = {}) => User.create({
    organization: org._id, firstName: key.charAt(0).toUpperCase() + key.slice(1), lastName: 'Tester', email: `${key}@${org.slug}.e2e.test`, passwordHash: hash, role,
    skills: [], isActive: true, emailVerified: true, hasCreatedOrganization: role === 'org-admin', ...over,
  });
  const F = await seedFixtures({ makeUser });

  const pair = createKeyPair();
  Object.assign(env, { AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1', AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: Number(process.env.E2E_MAX_OUTPUT || 450) });
  const realGroq = process.env.E2E_REAL_GROQ === '1';
  const groq = createFakeGroq({ control: true });
  await groq.listen(PORTS.groqControl);
  const internal = createInternalApp().listen(PORTS.internal, '127.0.0.1');
  const py = await startPython({ port: PORTS.python, publicKey: pair.publicKey, internalPort: PORTS.internal, groqBaseUrl: `http://127.0.0.1:${PORTS.groqControl}/openai/v1`, realGroq, redisPrefix: 'e2e:ai-service', extraEnv: { AI_FIRST_BYTE_TIMEOUT_MS: '20000', AI_STREAM_IDLE_TIMEOUT_MS: '20000', AI_MAX_RETRIES: realGroq ? '0' : '0' } });
  env.AI_SERVICE_URL = py.url;
  if (infoFile) { py.proc.stdout.on('data', (b) => fs.appendFileSync(`${infoFile}.python.log`, b)); py.proc.stderr.on('data', (b) => fs.appendFileSync(`${infoFile}.python.log`, b)); } // Python's own log (it never logs keys, tokens, prompts or results)
  const app = createApp();
  const api = app.listen(PORTS.api, '127.0.0.1');

  const accounts = Object.fromEntries(Object.entries(F.users).map(([k, u]) => [k, u.email]));
  const info = { ports: PORTS, db: env.MONGO_URI.split('/').pop(), password: PASSWORD, accounts, realGroq, apiBase: `http://127.0.0.1:${PORTS.api}/api/v1`, groqControl: `http://127.0.0.1:${PORTS.groqControl}`, ids: { skunk: String(F.projects.skunk._id), apollo: String(F.projects.apollo._id) } };
  if (infoFile) fs.writeFileSync(infoFile, JSON.stringify(info));
  console.log('E2E READY', JSON.stringify({ ports: PORTS, db: info.db, realGroq }));

  const shutdown = async () => {
    try { py.kill(); } catch { /* already gone */ }
    api.close(); internal.close(); await groq.close();
    try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
    try {
      const r = createRedisClient();
      const keys = [...await r.keys('e2e:*')];
      if (keys.length) await r.del(keys);
    } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((error) => { console.error('E2E server failed:', error.message); process.exit(1); });
