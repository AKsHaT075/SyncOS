/**
 * Writes ai/app/tools/contract.json: the model-facing definition (name, description, JSON-schema parameters) of every live-data
 * tool, taken from NODE's registry, which stays the authority. Python reads this file; both test suites compare against it, so
 * a change on either side that is not mirrored fails a test. Run after changing a tool:  node scripts/export-ai-tool-contract.js
 */
const fs = require('fs');
const path = require('path');
const { listToolDefinitions, clearTools } = require('../src/services/ai/aiToolRegistry');
const { registerLiveDataTools } = require('../src/services/ai/tools/liveDataTools');
const { PERMISSIONS } = require('../src/constants/permissions');

const TARGET = path.resolve(__dirname, '../../ai/app/tools/contract.json');

function buildContract() {
  clearTools();
  registerLiveDataTools();
  const tools = listToolDefinitions({ permissions: [PERMISSIONS.USE_AI] })
    .map(({ name, description, parameters }) => ({ name, description, parameters }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return { version: 1, tools };
}

if (require.main === module) {
  fs.writeFileSync(TARGET, `${JSON.stringify(buildContract(), null, 2)}\n`);
  console.log(`wrote ${TARGET}`);
  process.exit(0);
}

module.exports = { TARGET, buildContract };
