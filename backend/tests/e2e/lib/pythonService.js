/**
 * Starts the REAL Python AI service (uvicorn) for e2e. Two modes:
 *   fake Groq : GROQ_API_KEY is a dummy, GROQ_BASE_URL points at the local fake.
 *   real Groq : the key is read by a SHELL child from the gitignored ai/.env (`set -a; . ./.env`), so it never passes through Node's memory,
 *               logs, the Node process environment, or any file of ours. Python alone holds it.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const AI_DIR = path.resolve(__dirname, '../../../../ai');
const PYTHON = path.join(AI_DIR, '.venv/bin/python');
const HAVE_PYTHON = fs.existsSync(PYTHON);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startPython({ port, publicKey, internalPort, groqBaseUrl, realGroq = false, redisPrefix = 'e2e:ai-service', extraEnv = {} }) {
  const env = {
    PATH: process.env.PATH, AI_JWT_PUBLIC_KEY: publicKey, AI_JWT_KEY_ID: 'v1', AI_REPLAY_STORE: 'redis', REDIS_URL: 'redis://127.0.0.1:6379',
    AI_REDIS_PREFIX: redisPrefix, AI_MAX_RETRIES: '0', AI_NODE_INTERNAL_URL: `http://127.0.0.1:${internalPort}`, PORT: String(port), ...extraEnv,
  };
  if (!realGroq) { env.GROQ_API_KEY = 'gsk_E2E_FAKE_KEY'; env.GROQ_BASE_URL = groqBaseUrl; }
  const cmd = ['-m', 'uvicorn', 'app.main:build', '--factory', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'];
  const proc = realGroq
    ? spawn('/bin/sh', ['-c', `set -a; . ./.env; set +a; exec ${PYTHON} scripts/e2e_live_server.py`], { cwd: AI_DIR, env: { ...env, HOST: '127.0.0.1', E2E_GROQ_GAP_SECONDS: process.env.E2E_GROQ_GAP_SECONDS || '20' }, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(PYTHON, cmd, { cwd: AI_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const service = { port, url: `http://127.0.0.1:${port}`, proc, logs: '', kill: () => proc.kill('SIGTERM') };
  proc.stdout.on('data', (b) => { service.logs += b; });
  proc.stderr.on('data', (b) => { service.logs += b; });
  for (let i = 0; i < 120; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    try { if ((await fetch(`${service.url}/health`)).ok) return service; } catch { /* not up yet */ }
    // eslint-disable-next-line no-await-in-loop
    await sleep(150);
  }
  proc.kill('SIGTERM');
  throw new Error('the Python service did not start');
}

module.exports = { AI_DIR, HAVE_PYTHON, freePort, startPython };
