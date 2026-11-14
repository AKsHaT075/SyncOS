#!/usr/bin/env node
/**
 * Generates the ES256 (P-256) key pairs that link the Node backend and the Python AI service.
 *
 *   service pair   Node SIGNS generate/status tokens, Python VERIFIES
 *                  private -> Node only (AI_SERVICE_SIGNING_KEY_FILE)   public -> Python only (AI_JWT_PUBLIC_KEY_FILE)
 *   worker pair    the Python ingestion worker SIGNS, Node VERIFIES
 *                  private -> worker only (AI_WORKER_SIGNING_KEY_FILE)  public -> Node only (AI_WORKER_PUBLIC_KEY_FILE)
 *
 * Two pairs on purpose: neither key can be used for the other direction. Files go to <repo>/ai/keys/ (gitignored).
 * Each pair is created only if missing (an existing pair is never overwritten). Prints paths, never key material.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '../../ai/keys');
const PAIRS = {
  service: { priv: 'ai-jwt-private.pem', pub: 'ai-jwt-public.pem' },
  worker: { priv: 'ai-worker-private.pem', pub: 'ai-worker-public.pem' },
};

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const created = [];
for (const [name, files] of Object.entries(PAIRS)) {
  const privatePath = path.join(dir, files.priv);
  const publicPath = path.join(dir, files.pub);
  if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) {
    console.log(`Keeping the existing ${name} key pair.`);
    continue;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  created.push(name);
}

const p = (file) => path.join(dir, file);
console.log(created.length ? `\nGenerated: ${created.join(', ')}.` : '\nNothing to generate.');
console.log('\nAdd to backend/.env:');
console.log('  AI_SERVICE_URL=http://127.0.0.1:8001');
console.log(`  AI_SERVICE_SIGNING_KEY_FILE=${p(PAIRS.service.priv)}`);
console.log('  AI_SERVICE_KEY_ID=v1');
console.log(`  AI_WORKER_PUBLIC_KEY_FILE=${p(PAIRS.worker.pub)}`);
console.log('  AI_WORKER_KEY_ID=w1');
console.log('\nAdd to ai/.env (API process):');
console.log('  AI_JWT_KEY_ID=v1');
console.log(`  AI_JWT_PUBLIC_KEY_FILE=${p(PAIRS.service.pub)}`);
console.log('\nAdd to the ingestion worker environment (a SEPARATE process; it needs no Groq key):');
console.log('  AI_WORKER_KEY_ID=w1');
console.log(`  AI_WORKER_SIGNING_KEY_FILE=${p(PAIRS.worker.priv)}`);
console.log('  AI_NODE_INTERNAL_URL=http://127.0.0.1:5002');
