// REAL-BROWSER end-to-end run: the real AI Studio frontend (dev server) -> real Node SSE -> real Python -> scripted (fake) Groq -> real tools.
//   node tests/e2e/driveBrowser.mjs <infoFile> <outDir>        (e2e server running with the fake Groq; frontend on :3111 pointing at the e2e API)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [infoFile, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const info = JSON.parse(readFileSync(infoFile, 'utf8'));
const FRONT = process.env.E2E_FRONT || 'http://localhost:3111';
const API = info.apiBase.replace('127.0.0.1', 'localhost');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- scripted Groq (control API of the e2e server) --------------------------------------------------------------------------------------------
const chunk = (delta, finish = null, extra = {}) => ({ id: 'c', model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const usage = { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 };
const tool = (name, args = {}, delayMs = 0, id = `call_${name}`) => ({ delayMs, chunks: [chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, 'tool_calls', { usage })] });
const text = (t, delayMs = 0) => ({ delayMs, chunks: [chunk({ content: t }), chunk({}, 'stop', { usage })] });
const fail = (status = 500, delayMs = 0) => ({ delayMs, status, body: { error: { message: 'upstream exploded' } } });
const groq = {
  reset: () => fetch(`${info.groqControl}/__control/reset`, { method: 'POST', body: '{}' }),
  plans: (...p) => fetch(`${info.groqControl}/__control/plans`, { method: 'POST', body: JSON.stringify(p) }),
  state: async () => (await fetch(`${info.groqControl}/__control/requests`)).json(),
};

// ---- Chrome over raw CDP ----------------------------------------------------------------------------------------------------------------------
const PORT = 9334;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'e2e-chrome-'))}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 50; i += 1) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let msgId = 0; const waiting = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
const cdp = (method, params = {}) => new Promise((resolve, reject) => { msgId += 1; waiting.set(msgId, (d) => (d.error ? reject(new Error(d.error.message)) : resolve(d.result))); ws.send(JSON.stringify({ id: msgId, method, params })); });
const ev = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`.slice(0, 300)); return r.result.value; };
await cdp('Page.enable'); await cdp('Runtime.enable');

const results = [];
const check = (viewport, scenario, name, pass, detail = '') => results.push({ viewport, scenario, name, pass: Boolean(pass), detail });
const shot = async (v, name) => { const { data } = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, `${v.name}-${name}.png`), Buffer.from(data, 'base64')); };
const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr).catch(() => false)) return true; await sleep(40); } return false; };
const logText = `(document.querySelector('[role=log]') || document.body).innerText`;
const labels = `JSON.stringify([...document.querySelectorAll('[role=log] [role=status]')].map((e) => e.textContent.trim()))`;
const LABELS = ['Checking your tasks', 'Reviewing your schedule', 'Finding your projects', 'Reviewing project details', 'Checking project members', 'Reviewing project tasks', 'Looking up team information', 'Preparing workload summary'];

async function openStudio(v, user = 'emp1') {
  await cdp('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.mobile ? 2 : 1, mobile: v.mobile });
  await cdp('Page.navigate', { url: `${FRONT}/login` });
  await sleep(2500);
  // the REAL login API (csrf double-submit + password); the refresh cookie it sets is what AuthProvider restores the session from
  const ok = await ev(`(async () => { const api = ${JSON.stringify(API)}; const c = await (await fetch(api + '/auth/csrf-token', { credentials: 'include' })).json(); const r = await fetch(api + '/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-csrf-token': c.csrfToken }, body: JSON.stringify({ email: ${JSON.stringify(info.accounts[user])}, password: ${JSON.stringify(info.password)} }) }); return r.status; })()`);
  if (ok !== 200) throw new Error(`browser login failed: ${ok}`);
  await cdp('Page.navigate', { url: `${FRONT}/dashboard/ai-studio` });
  const ready = await waitFor(`Boolean(document.querySelector('textarea[aria-label=Message]'))`, 30000);
  if (!ready) { await shot(v, 'NOT-READY'); throw new Error(`AI Studio did not load at ${v.name}: ${(await ev('document.body.innerText')).slice(0, 200)}`); }
  await sleep(400);
}
async function ask(question) {
  await ev(`(() => { const t = document.querySelector('textarea[aria-label=Message]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(question)}); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(120);
  await ev(`document.querySelector('button[aria-label="Send message"]').click(); true`);
}
const overflow = () => ev(`JSON.stringify({ page: document.documentElement.scrollWidth - window.innerWidth, log: (() => { const l = document.querySelector('[role=log]'); return l ? l.scrollWidth - l.clientWidth : 0; })() })`).then(JSON.parse);
async function watch(until, ms = 30000) { // polls the real DOM, records every distinct activity label shown
  const seen = []; const end = Date.now() + ms;
  while (Date.now() < end) {
    const l = JSON.parse(await ev(labels)); if (l[0] && seen.at(-1) !== l[0]) seen.push(l[0]);
    if (await ev(until).catch(() => false)) break;
    await sleep(30);
  }
  return seen;
}
const idle = () => waitFor(`Boolean(document.querySelector('button[aria-label="Send message"]'))`, 30000);

const VIEWPORTS = [{ name: 'desktop-1280', width: 1280, height: 800, mobile: false }, { name: 'tablet-820', width: 820, height: 1180, mobile: true }, { name: 'mobile-390', width: 390, height: 844, mobile: true }];
for (const v of VIEWPORTS.filter((x) => !process.env.E2E_ONLY || x.name === process.env.E2E_ONLY)) {
  await groq.reset();
  await openStudio(v);

  // B1: the eight friendly labels, one tool per model round (so each stays on screen while the next round is generated)
  const triples = [[['list_my_tasks'], ['list_my_schedule', { range: 'today' }], ['list_projects']], [['get_project_overview', { project: 'Apollo' }], ['list_project_members', { project: 'Apollo' }], ['list_project_tasks', { project: 'Apollo' }]], [['get_team'], ['get_workload_summary', { scope: 'me' }]]];
  const allSeen = []; let tableLeak = false; let doneOk = true; let first = true;
  for (const [i, calls] of triples.entries()) {
    await groq.plans(...calls.map(([n, a]) => tool(n, a, 1100)), text(`ANSWER-${i}: all done.`, 200));
    await ask(`Lookup batch ${i}`);
    const seen = await watch(`${logText}.includes('ANSWER-${i}')`, 40000);
    allSeen.push(...seen);
    if (first) { first = false; }
    const body = await ev(logText);
    tableLeak ||= /list_my_tasks|get_workload_summary|tool_activity|call_|arguments/.test(body);
    doneOk &&= (await idle()) && JSON.parse(await ev(labels)).length === 0;
    if (i === 0) await shot(v, '1-after-first-answer');
  }
  const seenSet = new Set(allSeen.map((s) => s.replace(/…$/, '')));
  check(v.name, 'B1', 'all eight friendly labels were shown, from real events', LABELS.every((l) => seenSet.has(l)), JSON.stringify([...seenSet]));
  check(v.name, 'B1', 'labels appear in the order the tools ran', allSeen.map((s) => s.replace(/…$/, '')).filter((s) => LABELS.includes(s)).join('|') === ['Checking your tasks', 'Reviewing your schedule', 'Finding your projects', 'Reviewing project details', 'Checking project members', 'Reviewing project tasks', 'Looking up team information', 'Preparing workload summary'].join('|'), allSeen.join(' | '));
  check(v.name, 'B1', 'no tool names, ids, arguments or results in the transcript', !tableLeak, '');
  check(v.name, 'B1', 'after each final answer the indicator is gone and the composer is free', doneOk, '');
  const st = await groq.state();
  check(v.name, 'B1', 'real tools ran for this user: Groq received real project data in its tool messages', JSON.stringify(st.requests).includes('Apollo'), '');
  const o1 = await overflow();
  check(v.name, 'layout', 'no horizontal overflow after tool turns', o1.page <= 0 && o1.log <= 0, JSON.stringify(o1));

  // B2: a plain answer: nothing invented
  await groq.reset();
  await groq.plans(text('PLAIN-ANSWER here.', 600));
  await ask('Hello there');
  const seenPlain = await watch(`${logText}.includes('PLAIN-ANSWER')`);
  check(v.name, 'B2', 'a normal reply shows no tool activity at all', seenPlain.every((l) => !LABELS.some((x) => l.startsWith(x))), JSON.stringify(seenPlain));
  await idle();

  // B3: Stop during an activity
  await groq.reset();
  await groq.plans(tool('list_projects', {}, 300), text('NEVER-SHOWN', 20000));
  await ask('Stop test');
  const shown = await waitFor(`${logText}.includes('Finding your projects')`);
  check(v.name, 'B3', 'activity shown before Stop', shown, '');
  if (shown) await shot(v, '2-activity-before-stop');
  await ev(`document.querySelector('button[aria-label="Stop generating"]').click(); true`);
  await sleep(150);
  const afterStop = JSON.parse(await ev(labels));
  check(v.name, 'B3', 'Stop clears the activity immediately', afterStop.every((t) => !/Finding your projects/.test(t)), JSON.stringify(afterStop));
  check(v.name, 'B3', 'the composer is usable again after Stop', await idle(), '');
  check(v.name, 'B3', 'nothing from the cancelled turn appears later', !(await ev(logText)).includes('NEVER-SHOWN'), '');

  // B4: provider error after a tool round
  await groq.reset();
  await groq.plans(tool('get_team', {}, 300), fail(500, 200));
  await ask('Error test');
  await waitFor(`${logText}.includes('Looking up team information')`);
  await sleep(2500);
  await idle();
  const errBody = await ev('document.body.innerText'); const errLabels = JSON.parse(await ev(labels));
  check(v.name, 'B4', 'an error clears the activity and shows no internals', errLabels.length === 0 && !/upstream exploded|Mongo|stack|eyJ/.test(errBody), JSON.stringify(errLabels));
  await shot(v, '3-after-error');

  // B8: duplicate send protection (double-click Send)
  await groq.reset();
  await groq.plans(text('SINGLE-ANSWER', 700), text('SECOND-ANSWER-MUST-NOT-EXIST', 100));
  await ev(`(() => { const t = document.querySelector('textarea[aria-label=Message]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Double click me'); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(150);
  await ev(`(() => { const b = document.querySelector('button[aria-label="Send message"]'); b.click(); b.click(); return true; })()`);
  await waitFor(`${logText}.includes('SINGLE-ANSWER')`);
  await idle();
  const dups = (await groq.state()).requests.length;
  check(v.name, 'B8', 'a double-click makes ONE model request', dups === 1, `groq requests=${dups}`);
  check(v.name, 'B8', 'only one answer is shown', !(await ev(logText)).includes('SECOND-ANSWER'), '');

  // B5 (desktop only: the sidebar is a docked panel there): conversation switching during an activity. Self-contained: its own two fresh chats.
  if (v.name === 'desktop-1280') {
    const clickChat = (needle) => ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label=Conversations] button[type=button]')].find((x) => x.textContent.includes(${JSON.stringify(needle)})); if (!b) return false; b.click(); return true; })()`);
    await cdp('Page.navigate', { url: `${FRONT}/dashboard/ai-studio` }); // a fresh page: no conversation selected
    await waitFor(`Boolean(document.querySelector('textarea[aria-label=Message]'))`, 30000);
    await sleep(500);
    await groq.reset();
    await groq.plans(text('TARGET-ANSWER ready.', 150));
    await ask('Target conversation');
    await waitFor(`${logText}.includes('TARGET-ANSWER')`);
    await idle();
    await waitFor(`[...document.querySelectorAll('button')].some((b) => /New chat/.test(b.textContent))`, 15000);
    await ev(`[...document.querySelectorAll('button')].find((b) => /New chat/.test(b.textContent)).click(); true`);
    await sleep(600);
    await groq.reset();
    await groq.plans(tool('list_my_tasks', {}, 400), text('STALE-ANSWER-MUST-NOT-APPEAR', 3000));
    await ask('Switch test');
    await waitFor(`${logText}.includes('Checking your tasks')`);
    const before = await ev('location.search');
    await waitFor(`[...document.querySelectorAll('nav[aria-label=Conversations] button')].some((b) => b.textContent.includes('Target conversation'))`, 8000);
    const clicked = await clickChat('Target conversation');
    await sleep(500);
    const after = await ev('location.search');
    check(v.name, 'B5', 'a DIFFERENT conversation was opened from the sidebar (the URL changed)', clicked && before !== after, `${before} -> ${after}`);
    await sleep(4500);
    const swLabels = JSON.parse(await ev(labels)); const swBody = await ev(logText);
    check(v.name, 'B5', 'switching clears the activity; the abandoned turn never appears in the new conversation', swLabels.length === 0 && swBody.includes('TARGET-ANSWER') && !swBody.includes('STALE-ANSWER') && !/Checking your tasks/.test(swBody), JSON.stringify({ swLabels, body: swBody.slice(0, 120) }));
    await shot(v, '4-after-switch');
    await waitFor(`[...document.querySelectorAll('nav[aria-label=Conversations] button')].some((b) => b.textContent.includes('Switch test'))`, 8000);
    await clickChat('Switch test');
    await sleep(1500);
    const abandoned = await ev(logText);
    check(v.name, 'B5', 'the abandoned turn was saved as stopped (not completed) and never received the late answer', /stopped before it finished/.test(abandoned) && !abandoned.includes('STALE-ANSWER'), abandoned.slice(0, 160));
    await shot(v, '5-abandoned-turn');
  }
  const o2 = await overflow();
  check(v.name, 'layout', 'no horizontal overflow at the end', o2.page <= 0 && o2.log <= 0, JSON.stringify(o2));
}

writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }));
for (const f of failed) console.log('FAIL', f.viewport, f.scenario, f.name, f.detail.slice(0, 160));
ws.close(); chrome.kill('SIGTERM');
process.exit(0);
