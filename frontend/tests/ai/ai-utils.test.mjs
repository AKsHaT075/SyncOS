import test from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../../src/features/ai/utils/sse.js";
import { isSupportedLanguage } from "../../src/features/ai/utils/language.js";
import { documentHref, formatLocation, normalizeCitations } from "../../src/features/ai/utils/citations.js";
import { describeAiError } from "../../src/features/ai/utils/errors.js";
import { isSafeUrl, parseBlocks, parseInline } from "../../src/features/ai/utils/markdown.js";

test("SSE: events split across chunks, CRLF, comments and malformed data", () => {
  const p = createSseParser();
  assert.deepEqual(p.push('event: text\ndata: {"type":"te'), []);
  assert.equal(p.pending, true);
  const first = p.push('xt","text":"Hi"}\n\n: ping\n\nevent: done\r\ndata: {"type":"done"}\r\n\r\n');
  assert.deepEqual(first.map((e) => e.event), ["text", "done"]);
  assert.equal(first[0].data.text, "Hi");
  assert.deepEqual(p.push("event: x\ndata: {not json}\n\n"), []);
  assert.equal(p.pending, false);
});

test("SSE: multi-line data is joined", () => {
  const [e] = createSseParser().push('data: {"a":\ndata: 1}\n\n');
  assert.deepEqual(e.data, { a: 1 });
});

test("language policy mirrors the backend", () => {
  for (const ok of ["How many leave days?", "12345", "", "What does the 'chhutti' policy say?", "Sync OS में leave"]) assert.equal(isSupportedLanguage(ok), true, ok); // a little non-English inside an English question is fine
  for (const bad of ["एक साल में कितनी छुट्टियाँ मिलती हैं?", "ਇੱਕ ਸਾਲ ਵਿੱਚ ਕਿੰਨੀਆਂ ਛੁੱਟੀਆਂ", "كم عدد أيام الإجازة؟", "Sync OS में छुट्टी की नीति क्या है और कितने दिन मिलते हैं"]) assert.equal(isSupportedLanguage(bad), false);
});

test("citations: location text, links only for available sources, no invention", () => {
  assert.equal(formatLocation({ pageStart: 3, pageEnd: 3 }), "Page 3");
  assert.equal(formatLocation({ pageStart: 3, pageEnd: 5 }), "Pages 3–5");
  assert.equal(formatLocation({ sheet: "Q1", rowStart: 2, rowEnd: 9 }), "Sheet Q1 · Rows 2–9");
  assert.equal(formatLocation({ slideStart: 4, slideEnd: 4 }), "Slide 4");
  assert.equal(formatLocation({ headingPath: ["Leave", "Carry over"] }), "Leave › Carry over");
  assert.equal(formatLocation({ charStart: 0, charEnd: 90 }), "");
  assert.equal(formatLocation(null), "");
  const id = "a".repeat(24);
  assert.equal(documentHref({ n: 1, available: true, documentId: id }), `/dashboard/documents?doc=${id}`);
  assert.equal(documentHref({ n: 1, documentId: id }), `/dashboard/documents?doc=${id}`); // streamed citations carry no flag
  assert.equal(documentHref({ n: 1, available: false, documentId: id }), null);
  assert.equal(documentHref({ n: 1, available: true, documentId: "../etc" }), null);
  assert.deepEqual(normalizeCitations([{ n: 2, documentId: id, documentName: "B" }, { n: 1, available: false, documentName: "LEAK" }, { nope: true }]), [{ n: 1, available: false }, { n: 2, documentId: id, documentName: "B", available: true }]);
  assert.deepEqual(normalizeCitations(undefined), []);
});

test("error messages are mapped from codes and never echo server text for 5xx", () => {
  assert.match(describeAiError({ status: 409, code: "CONVERSATION_BUSY" }), /still answering/);
  assert.match(describeAiError({ status: 429, code: "AI_QUOTA_USER_DAILY" }), /usage limit/);
  assert.equal(describeAiError({ status: 500, message: "mongo exploded at /srv/app" }), "Something went wrong while generating the reply. Please try again.");
  assert.match(describeAiError({ status: 404 }), /no longer available/);
});

test("markdown: blocks", () => {
  const blocks = parseBlocks("# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n  - c\n\n1. one\n2. two\n\n> quote\n\n---\n\n```js\nconst x = 1;\n```");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "list", "list", "blockquote", "hr", "code"]);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[2].items[1].sub[0].items.length, 1);
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual([blocks[6].lang, blocks[6].text, blocks[6].closed], ["js", "const x = 1;", true]);
});

test("markdown: an unfinished fence (streaming) is code so far, not lost text", () => {
  const [b] = parseBlocks("```py\nprint(1)\nprint(");
  assert.deepEqual([b.type, b.closed, b.text], ["code", false, "print(1)\nprint("]);
});

test("markdown: tables", () => {
  const [t] = parseBlocks("| a | b |\n|---|--:|\n| 1 | 2 |\n| 3 | 4 |");
  assert.equal(t.type, "table");
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.align, ["left", "right"]);
});

test("markdown: inline - citations, links, emphasis, snake_case, escapes", () => {
  assert.deepEqual(parseInline("Leave is 24 days [1][2].").filter((n) => n.type === "cite").map((n) => n.n), [1, 2]);
  assert.equal(parseInline("array[0] and [text](nope)").some((n) => n.type === "cite" && n.n === 0), true); // [0] is a marker syntactically; the renderer only links markers that match a real source
  assert.equal(parseInline("snake_case_name stays").length, 1);
  assert.equal(parseInline("*it* and _it_").filter((n) => n.type === "em").length, 2);
  assert.deepEqual(parseInline("\\*not em\\*"), [{ type: "text", text: "*not em*" }]);
  const [link] = parseInline("[site](https://example.com/a?b=1)");
  assert.deepEqual([link.type, link.href], ["link", "https://example.com/a?b=1"]);
});

test("markdown: SAFETY - unsafe URLs and HTML never become links or elements", () => {
  for (const url of ["javascript:alert(1)", "data:text/html;base64,AAAA", "vbscript:x", "//evil.example", "/relative", " JaVaScRiPt:alert(1)"]) assert.equal(isSafeUrl(url), false, url);
  assert.equal(isSafeUrl("https://ok.example"), true);
  assert.equal(parseInline("[x](javascript:alert(1))").some((n) => n.type === "link"), false);
  const html = parseBlocks("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
  assert.ok(html.every((b) => b.type === "paragraph")); // plain text nodes only: the renderer escapes them
  assert.ok(JSON.stringify(html).includes("<script>")); // kept as TEXT (React renders it inert)
});

test("markdown: pathological input terminates", () => {
  const t = Date.now();
  parseBlocks("*".repeat(20000) + "\n" + "[".repeat(5000) + "\n" + "`".repeat(5000) + "\n" + "> ".repeat(2000) + "x");
  parseInline("**_*".repeat(5000));
  assert.ok(Date.now() - t < 3000);
});

import { hasStreamingReply, visibleMessages } from "../../src/features/ai/utils/transcript.js";

test("transcript: while a turn is live, saved copies of that turn are hidden (regression: empty saved reply replaced the live text)", () => {
  const saved = [
    { id: "u0", seq: 1, role: "user", content: "old q" },
    { id: "a0", seq: 2, role: "assistant", content: "old a" },
    { id: "u1", seq: 3, role: "user", content: "new q" }, // already saved by the server mid-stream
    { id: "a1", seq: 4, role: "assistant", content: "", status: "streaming" }, // the empty saved copy of the live reply
  ];
  assert.deepEqual(visibleMessages(saved, { baseSeq: 2 }).map((m) => m.id), ["u0", "a0"]);
  assert.deepEqual(visibleMessages(saved, null).map((m) => m.id), ["u0", "a0", "u1", "a1"]); // turn over: everything saved is shown
  assert.deepEqual(visibleMessages([], { baseSeq: 0 }), []); // new conversation: nothing saved is shown while live
});

test("transcript: polling continues only while the newest saved reply is still streaming", () => {
  const page = (messages) => ({ pages: [{ messages }] });
  assert.equal(hasStreamingReply(page([{ role: "user" }, { role: "assistant", status: "streaming" }])), true);
  assert.equal(hasStreamingReply(page([{ role: "user" }, { role: "assistant", status: "incomplete" }])), false);
  assert.equal(hasStreamingReply(page([{ role: "assistant", status: "complete" }])), false);
  assert.equal(hasStreamingReply(page([])), false);
  assert.equal(hasStreamingReply(undefined), false);
});
