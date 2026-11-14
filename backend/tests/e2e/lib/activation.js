/**
 * TEST-ONLY switch for the isolated end-to-end environment (Phase 8 Step 8 / 9). Production code has its own activation path now: `ask.service.streamAnswer`
 * offers live tools only when the deploy-time flag AI_LIVE_TOOLS_ENABLED is set AND the user / role / AI / live-data settings and platform switches allow it.
 * The e2e suites no longer patch anything: they turn on THAT flag, in the e2e process only, and this module refuses to do so unless the process is clearly
 * isolated (not production, a throw-away database name, a test Redis prefix).
 */
function assertIsolated() {
  const uri = process.env.MONGO_URI || '';
  const prefix = process.env.AI_REDIS_PREFIX || '';
  if (process.env.NODE_ENV === 'production') throw new Error('e2e activation refused: production');
  if (!/\/syncos_(test|e2e)_[^/?]*$/.test(uri.split('?')[0])) throw new Error('e2e activation refused: not an isolated test database');
  if (!/^(test|e2e):/.test(prefix)) throw new Error('e2e activation refused: not an isolated Redis prefix');
}

/** Switches the real activation flag on for THIS process only. Returns a function that restores the previous value. */
function enableLiveToolsForIsolatedTest(env) {
  assertIsolated();
  const previous = env.AI_LIVE_TOOLS_ENABLED;
  env.AI_LIVE_TOOLS_ENABLED = true;
  return () => { env.AI_LIVE_TOOLS_ENABLED = previous; };
}

module.exports = { assertIsolated, enableLiveToolsForIsolatedTest };
