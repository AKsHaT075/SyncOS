import test from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../../src/features/ai/utils/sse.js";
import { TOOL_ACTIVITY_LABELS, parseToolActivity } from "../../src/features/ai/utils/toolActivity.js";
import { applyStreamEvent, createRequestGuard, markStopping, newPending } from "../../src/features/ai/utils/liveTurn.js";
import { parseBlocks } from "../../src/features/ai/utils/markdown.js";

const EXPECTED = {
  list_my_tasks: "Checking your tasks",
  list_my_schedule: "Reviewing your schedule",
  list_projects: "Finding your projects",
  get_project_overview: "Reviewing project details",
  list_project_members: "Checking project members",
  list_project_tasks: "Reviewing project tasks",
  get_team: "Looking up team information",
  get_workload_summary: "Preparing workload summary",
};
const activity = (tool, extra = {}) => ({ type: "tool_activity", tool, ...extra });
const wire = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/** Feeds SSE TEXT through the real parser into the real reducer, like the hook does. */
function play(chunks, start = newPending({ userText: "How many projects?" })) {
  const parser = createSseParser();
  let pending = start;
  const states = [];
  for (const chunk of chunks) {
    for (const { event, data } of parser.push(chunk)) {
      pending = applyStreamEvent(pending, event, data);
      states.push({ event, activity: pending.activity, text: pending.assistantText, phase: pending.phase });
    }
  }
  return { pending, states };
}

// ---- mapping ------------------------------------------------------------------------------------------------------------------------

test("exactly the eight tools, with exactly the approved descriptions", () => {
  assert.deepEqual(TOOL_ACTIVITY_LABELS, EXPECTED);
  assert.equal(Object.keys(TOOL_ACTIVITY_LABELS).length, 8);
  assert.ok(Object.isFrozen(TOOL_ACTIVITY_LABELS));
});

for (const [tool, label] of Object.entries(EXPECTED)) {
  test(`maps ${tool}`, () => {
    assert.deepEqual(parseToolActivity("tool_activity", activity(tool)), { tool, label });
  });
}

test("unknown, missing, non-string and malformed events are ignored", () => {
  const bad = [
    ["tool_activity", activity("delete_everything")],
    ["tool_activity", activity("LIST_PROJECTS")],
    ["tool_activity", activity("list_projects ")],
    ["tool_activity", activity("constructor")],
    ["tool_activity", activity("__proto__")],
    ["tool_activity", activity("toString")],
    ["tool_activity", activity("hasOwnProperty")],
    ["tool_activity", activity("")],
    ["tool_activity", { type: "tool_activity" }],
    ["tool_activity", { type: "tool_activity", tool: null }],
    ["tool_activity", { type: "tool_activity", tool: 7 }],
    ["tool_activity", { type: "tool_activity", tool: ["list_projects"] }],
    ["tool_activity", { type: "tool_activity", tool: { name: "list_projects" } }],
    ["tool_activity", { tool: "list_projects" }],
    ["tool_activity", { type: "text", tool: "list_projects" }],
    ["tool_activity", null], ["tool_activity", undefined], ["tool_activity", "list_projects"], ["tool_activity", 5], ["tool_activity", []], ["tool_activity", [activity("list_projects")]],
    ["text", activity("list_projects")], // the SSE event NAME must be tool_activity too
    ["message", activity("list_projects")], ["", activity("list_projects")], [undefined, activity("list_projects")],
  ];
  for (const [name, data] of bad) assert.equal(parseToolActivity(name, data), null, JSON.stringify([name, data]));
});

test("extra fields are ignored: the event must have exactly two", () => {
  for (const extra of [{ arguments: { a: 1 } }, { id: "call_1" }, { result: {} }, { label: "Hacked" }, { projectId: "65a" }, { token: "eyJ" }]) {
    assert.equal(parseToolActivity("tool_activity", activity("list_projects", extra)), null, JSON.stringify(extra));
  }
  const withProto = JSON.parse('{"type":"tool_activity","tool":"list_projects","__proto__":{"x":1}}'); // an own "__proto__" key
  assert.equal(parseToolActivity("tool_activity", withProto), null);
});

test("what is shown never comes from the event: only the fixed table", () => {
  const hostile = activity("list_projects", {});
  hostile.label = "<img src=x onerror=alert(1)>";
  assert.equal(parseToolActivity("tool_activity", hostile), null);
  assert.equal(parseToolActivity("tool_activity", activity("list_projects")).label, "Finding your projects");
});

// ---- the live turn, driven by real SSE text -----------------------------------------------------------------------------------------

test("a valid event sets the activity; a following one replaces it", () => {
  const { states, pending } = play([wire("tool_activity", activity("list_my_tasks")), wire("tool_activity", activity("get_team"))]);
  assert.deepEqual(states.map((s) => s.activity), ["Checking your tasks", "Looking up team information"]);
  assert.equal(pending.assistantText, ""); // activity is never reply text
});

test("no event, no indicator: a normal response is unchanged", () => {
  const { states, pending } = play([wire("meta", { userMessageId: "u", assistantMessageId: "a" }), wire("retrieval", { sourcesUsed: 2 }), wire("text", { type: "text", text: "Hello" }), wire("usage", { type: "usage" }), wire("done", { finishReason: "stop" })]);
  assert.ok(states.every((s) => s.activity === null));
  assert.equal(pending.assistantText, "Hello");
  assert.equal(pending.finishReason, "stop");
  assert.equal(pending.assistantMessageId, "a");
  assert.equal(pending.sourcesUsed, 2);
});

test("the first answer text clears the indicator, later text keeps streaming normally", () => {
  const { states, pending } = play([wire("tool_activity", activity("list_projects")), wire("text", { type: "text", text: "You " }), wire("text", { type: "text", text: "have 3." })]);
  assert.deepEqual(states.map((s) => s.activity), ["Finding your projects", null, null]);
  assert.equal(pending.assistantText, "You have 3.");
  assert.equal(pending.phase, "streaming");
});

test("done clears the indicator", () => {
  const { pending } = play([wire("tool_activity", activity("list_projects")), wire("done", { finishReason: "stop" })]);
  assert.equal(pending.activity, null);
  assert.equal(pending.finishReason, "stop");
});

test("error clears the indicator and shows no backend text", () => {
  const { pending } = play([wire("tool_activity", activity("get_workload_summary")), wire("error", { type: "error", code: "AI_PROVIDER_TOOL_ERROR", message: "Mongo at 10.0.0.5 exploded" })]);
  assert.equal(pending.activity, null);
  assert.equal(pending.assistantText, "");
  assert.ok(!JSON.stringify(pending).includes("10.0.0.5"));
});

test("Stop clears the indicator at once, and a late event cannot bring it back", () => {
  let p = applyStreamEvent(newPending({ userText: "q" }), "tool_activity", activity("list_my_schedule"));
  assert.equal(p.activity, "Reviewing your schedule");
  p = markStopping(p);
  assert.equal(p.activity, null);
  assert.equal(p.phase, "stopping");
  assert.equal(applyStreamEvent(p, "tool_activity", activity("get_team")).activity, null);
  assert.equal(applyStreamEvent(p, "text", { text: "x" }).phase, "stopping"); // existing Stop behaviour preserved
});

test("activity arriving after the answer started is ignored (the indicator is already gone)", () => {
  const { pending } = play([wire("text", { type: "text", text: "Answer" }), wire("tool_activity", activity("list_projects"))]);
  assert.equal(pending.activity, null);
});

test("malformed or unknown events do nothing and never throw", () => {
  const start = newPending({ userText: "q" });
  for (const [name, data] of [["tool_activity", activity("nope")], ["tool_activity", null], ["tool_activity", activity("list_projects", { x: 1 })], ["tool_call", { tool: "list_projects" }], ["tool_calls", { calls: [] }], ["whatever", {}], ["message", activity("list_projects")]]) {
    assert.equal(applyStreamEvent(start, name, data), start, name); // the SAME object: nothing changed
  }
  assert.equal(applyStreamEvent(null, "text", { text: "x" }), null); // no turn in flight
});

test("tool activity never becomes assistant Markdown, and tool-call JSON in an event is never rendered", () => {
  const { pending } = play([
    wire("tool_activity", activity("list_projects")),
    wire("tool_calls", { type: "tool_calls", calls: [{ id: "call_1", name: "list_projects", arguments: '{"project":"SECRET"}' }] }),
    wire("tool_activity", { type: "tool_activity", tool: "list_projects", arguments: { project: "SECRET" } }),
    wire("text", { type: "text", text: "You have 3 projects." }),
  ]);
  assert.equal(pending.assistantText, "You have 3 projects.");
  const rendered = JSON.stringify(parseBlocks(pending.assistantText));
  assert.ok(!/Finding your projects|list_projects|tool_calls|SECRET|call_1/.test(rendered + JSON.stringify(pending.assistantText)));
  assert.ok(!JSON.stringify(pending).includes("SECRET"));
});

test("events split across network chunks are handled the same", () => {
  const whole = wire("tool_activity", activity("list_project_members")) + wire("text", { type: "text", text: "Hi" });
  const { states } = play([whole.slice(0, 20), whole.slice(20, 61), whole.slice(61)]);
  assert.deepEqual(states.map((s) => s.activity), ["Checking project members", null]);
});

test("existing events keep their effects through the reducer", () => {
  let p = newPending({ baseSeq: 4, userText: "q" });
  assert.equal(p.baseSeq, 4);
  p = applyStreamEvent(p, "citations", { citations: [{ n: 1, chunkId: "c", documentId: "d", documentName: "Handbook.pdf", version: 1, chunkIndex: 0, location: {}, available: true }] });
  assert.equal(p.citations.length, 1);
  assert.equal(p.citations[0].documentName, "Handbook.pdf");
});

// ---- stale requests -----------------------------------------------------------------------------------------------------------------

test("a stale request can no longer update the screen after a switch, a new send, or unmount", () => {
  const guard = createRequestGuard();
  const first = guard.begin();
  assert.equal(guard.isCurrent(first), true);
  guard.invalidate(); // switched conversation
  assert.equal(guard.isCurrent(first), false);
  const second = guard.begin(); // a new send in the new conversation
  assert.equal(guard.isCurrent(second), true);
  assert.equal(guard.isCurrent(first), false); // the old request's late event is still refused
  guard.begin(); // yet another send
  assert.equal(guard.isCurrent(second), false);
});

test("simulated hook: a late tool_activity of the OLD request never reaches the NEW conversation's turn", () => {
  const guard = createRequestGuard();
  let screen = null; // what the hook's `pending` state would be
  const handle = (token) => (event, data) => { if (guard.isCurrent(token)) screen = applyStreamEvent(screen, event, data); };

  const oldToken = guard.begin();
  screen = newPending({ userText: "old question" });
  const oldHandler = handle(oldToken);
  oldHandler("tool_activity", activity("list_my_tasks"));
  assert.equal(screen.activity, "Checking your tasks");

  guard.invalidate(); // the user switched conversations: the hook clears pending and aborts
  screen = null;
  const newToken = guard.begin();
  screen = newPending({ userText: "new question" });
  const newHandler = handle(newToken);

  oldHandler("tool_activity", activity("get_team")); // a straggler, read from the old connection before it closed
  oldHandler("text", { text: "OLD ANSWER" });
  assert.equal(screen.activity, null);
  assert.equal(screen.assistantText, "");
  assert.equal(screen.userText, "new question");

  newHandler("tool_activity", activity("list_projects"));
  assert.equal(screen.activity, "Finding your projects");
});

test("a conversation switch clears the activity (pending is dropped entirely)", () => {
  // useChatSession sets pending to null when the conversation changes; the indicator lives only inside pending.
  let pending = applyStreamEvent(newPending({ userText: "q" }), "tool_activity", activity("get_team"));
  assert.equal(pending.activity, "Looking up team information");
  pending = null;
  assert.equal(applyStreamEvent(pending, "tool_activity", activity("get_team")), null);
});

test("duplicate-send protection and the rest of the session contract are untouched by this module", async () => {
  const { readFile } = await import("node:fs/promises");
  const hook = await readFile(new URL("../../src/features/ai/hooks/useChatSession.js", import.meta.url), "utf8");
  assert.match(hook, /if \(!text \|\| lock\.current\) return false;/); // the ref lock
  assert.match(hook, /lock\.current = false;/); // released on every exit
  assert.match(hook, /guard\.current\.isCurrent\(token\)/); // stale-request guard
  assert.match(hook, /controller\.signal\.aborted/);
  assert.match(hook, /await resync\(id\)/); // dropped connection recovery
  assert.match(hook, /Connection lost/);
  assert.match(hook, /onRestoreDraft/);
});
