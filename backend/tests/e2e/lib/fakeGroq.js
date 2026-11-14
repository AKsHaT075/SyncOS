/**
 * A scriptable OpenAI-compatible Groq stand-in (SSE). Plans are consumed in order; a plan is an object or a function(body, index) -> object:
 *   { chunks: [...], gapMs, hang, status, body, delayMs }
 * Records every request (so tests can read exactly what Groq was given) and counts client disconnects.
 * Optional control API (for a standalone server): POST /__control/plans [..], POST /__control/reset, GET /__control/requests.
 */
const http = require('http');

const chunk = (delta, finish = null, extra = {}) => ({ id: 'cmpl-1', model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const USAGE = (i = 120, o = 12) => ({ prompt_tokens: i, completion_tokens: o, total_tokens: i + o });
const toolPlan = (calls, { usage = USAGE(), preamble } = {}) => ({
  chunks: [
    ...(preamble ? [chunk({ content: preamble })] : []),
    chunk({ tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}) } })) }),
    chunk({}, 'tool_calls', { usage }),
  ],
});
const textPlan = (text, { usage = USAGE(200, 20), pieces } = {}) => ({ chunks: [...(pieces || [text]).map((t) => chunk({ content: t })), chunk({}, 'stop', { usage })] });
const errorPlan = (status = 400, code = 'tool_use_failed') => ({ status, body: { error: { message: 'Failed to call a function. Please adjust your prompt.', type: 'invalid_request_error', code, failed_generation: '<<DRAFT>>' } } });

function createFakeGroq({ control = false } = {}) {
  const state = { requests: [], plans: [], disconnects: 0, started: 0 };
  state.server = http.createServer(async (req, res) => {
    if (control && req.url.startsWith('/__control/')) {
      const parts = [];
      for await (const p of req) parts.push(p);
      const raw = Buffer.concat(parts).toString();
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/__control/plans') { state.plans.push(...JSON.parse(raw || '[]')); return res.end('{"ok":true}'); }
      if (req.url === '/__control/reset') { state.plans.length = 0; state.requests.length = 0; state.disconnects = 0; return res.end('{"ok":true}'); }
      if (req.url === '/__control/requests') return res.end(JSON.stringify({ requests: state.requests, disconnects: state.disconnects }));
      return res.end('{}');
    }
    const parts = [];
    for await (const p of req) parts.push(p);
    const body = JSON.parse(Buffer.concat(parts).toString() || '{}');
    const index = state.requests.length;
    state.requests.push(body);
    state.started += 1;
    res.on('close', () => { if (!res.writableFinished) state.disconnects += 1; });
    let plan = state.plans.shift() || textPlan('default answer');
    if (typeof plan === 'function') plan = await plan(body, index);
    if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
    if (plan.status) {
      res.writeHead(plan.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(plan.body || { error: { message: 'x' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    for (const c of plan.chunks) {
      res.write(`data: ${JSON.stringify(c)}\n\n`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, plan.gapMs || 3));
    }
    if (plan.hang) return undefined;
    res.write('data: [DONE]\n\n');
    return res.end();
  });
  state.listen = (port = 0) => new Promise((resolve) => state.server.listen(port, '127.0.0.1', () => { state.port = state.server.address().port; resolve(state.port); }));
  state.close = () => new Promise((resolve) => { state.server.closeAllConnections?.(); state.server.close(resolve); });
  state.reset = () => { state.plans.length = 0; state.requests.length = 0; state.disconnects = 0; };
  state.queue = (...plans) => { state.plans.push(...plans); return state; };
  /** The tool messages Groq was given in request `index` (parsed), in order. */
  state.toolMessages = (index) => (state.requests[index]?.messages || []).filter((m) => m.role === 'tool').map((m) => ({ id: m.tool_call_id, name: m.name, ...JSON.parse(m.content) }));
  return state;
}

module.exports = { USAGE, createFakeGroq, errorPlan, textPlan, toolPlan };
