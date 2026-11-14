// Minimal real client for the e2e server: the real login flow (CSRF double-submit cookie + password), then the real SSE chat endpoint.
export async function login(base, email, password) {
  const jar = new Map();
  const keep = (res) => { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let r = await fetch(`${base}/auth/csrf-token`); keep(r);
  const { csrfToken } = await r.json();
  r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken, cookie: cookie() }, body: JSON.stringify({ email, password }) });
  keep(r);
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status}`);
  const { accessToken } = await r.json();
  r = await fetch(`${base}/auth/csrf-token`, { headers: { cookie: cookie() } }); keep(r); // login rotates the CSRF cookie: take the matching token
  const fresh = (await r.json()).csrfToken;
  const headers = (extra = {}) => ({ 'Content-Type': 'application/json', 'x-csrf-token': fresh, Authorization: `Bearer ${accessToken}`, cookie: cookie(), ...extra });
  return {
    base, headers, accessToken, csrfToken: fresh,
    get: (path) => fetch(`${base}${path}`, { headers: headers() }),
    post: (path, body, extra) => fetch(`${base}${path}`, { method: 'POST', headers: headers(extra), body: JSON.stringify(body ?? {}) }),
  };
}

export async function chat(session, content, { conversationId } = {}) {
  const started = Date.now();
  const id = conversationId || (await (await session.post('/ai/conversations', {})).json()).conversation.id;
  const res = await session.post(`/ai/conversations/${id}/messages`, { content }, { Accept: 'text/event-stream' });
  const raw = await res.text();
  const events = res.status === 200 ? raw.trim().split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('data: ')[1])) : [];
  return { status: res.status, events, conversationId: id, ms: Date.now() - started, raw };
}
export const answerOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');
export const toolsOf = (events) => events.filter((e) => e.type === 'tool_activity').map((e) => e.tool);

/** Reads the SSE stream incrementally and ABORTS the request once `stop(events)` is true (the browser pressing Stop mid-way). Returns what had arrived. */
export async function chatUntil(session, content, stop) {
  const id = (await (await session.post('/ai/conversations', {})).json()).conversation.id;
  const controller = new AbortController();
  const res = await fetch(`${session.base}/ai/conversations/${id}/messages`, { method: 'POST', signal: controller.signal, headers: session.headers({ Accept: 'text/event-stream' }), body: JSON.stringify({ content }) });
  const events = []; let buffer = '';
  try {
    const reader = res.body.getReader(); const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n'); buffer = blocks.pop();
      for (const b of blocks.filter((x) => x.startsWith('event:'))) events.push(JSON.parse(b.split('data: ')[1]));
      if (stop(events)) { controller.abort(); break; }
    }
  } catch { /* aborted */ }
  return { events, conversationId: id, status: res.status };
}
