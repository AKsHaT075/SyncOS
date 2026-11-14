/**
 * A small, SAFE markdown parser (pure). It produces a plain data tree; the renderer turns it into React elements, so model or
 * document text can never become raw HTML. Links are limited to http(s)/mailto. Supports: headings, paragraphs, bold, italic,
 * inline code, fenced code, lists (one nesting level), blockquotes, rules, simple tables, links and [n] citation markers.
 * Unfinished constructs (a streaming reply) degrade gracefully: an open code fence is shown as code so far.
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const MAX_DEPTH = 4;

export const isSafeUrl = (url) => SAFE_URL.test(String(url || "").trim());

export function parseInline(src, depth = 0) {
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push({ type: "text", text: buf });
    buf = "";
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\](){}#+\-.!<>~|]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_DEPTH && src.startsWith("**", i)) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (depth < MAX_DEPTH && (ch === "*" || ch === "_") && src[i + 1] && !/\s/.test(src[i + 1])) {
      const prev = i > 0 ? src[i - 1] : " ";
      const wordBoundaryOk = ch === "*" || !/[\p{L}\p{N}]/u.test(prev); // snake_case stays snake_case
      const end = wordBoundaryOk ? src.indexOf(ch, i + 1) : -1;
      if (end > i + 1 && !/\s/.test(src[end - 1]) && src[end + 1] !== ch) {
        flush();
        out.push({ type: "em", children: parseInline(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const cite = /^\[(\d{1,3})\]/.exec(src.slice(i, i + 6));
      if (cite) {
        flush();
        out.push({ type: "cite", n: Number(cite[1]) });
        i += cite[0].length;
        continue;
      }
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (link && isSafeUrl(link[2])) {
        flush();
        out.push({ type: "link", href: link[2], children: parseInline(link[1], MAX_DEPTH) });
        i += link[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function parseBlocks(text, depth = 0) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) { closed = true; i += 1; break; }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n"), closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) }); i += 1; continue; }

    if (RULE.test(line)) { blocks.push({ type: "hr" }); i += 1; continue; }

    if (depth < 2 && /^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { quoted.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i += 1; }
      blocks.push({ type: "blockquote", children: parseBlocks(quoted.join("\n"), depth + 1) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitRow(line).map((c) => parseInline(c));
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : "left"));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { rows.push(splitRow(lines[i]).map((c) => parseInline(c))); i += 1; }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered && !bullet);
      const baseIndent = (bullet || ordered)[1].length;
      const items = [];
      const start = isOrdered ? Number(ordered[2]) : 1;
      while (i < lines.length) {
        const m = isOrdered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (m && m[1].length <= baseIndent + 1) {
          items.push({ children: parseInline(m[3]), sub: null });
          i += 1;
        } else if (m && items.length && m[1].length > baseIndent + 1 && depth < 2) {
          const sub = [];
          while (i < lines.length && (BULLET.test(lines[i]) || ORDERED.test(lines[i])) && ((BULLET.exec(lines[i]) || ORDERED.exec(lines[i]))[1].length > baseIndent + 1)) { sub.push(lines[i].replace(/^\s+/, "")); i += 1; }
          items[items.length - 1].sub = parseBlocks(sub.join("\n"), depth + 1);
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) {
          items[items.length - 1].children.push({ type: "text", text: ` ${lines[i].trim()}` }); // lazy continuation
          i += 1;
        } else break;
      }
      blocks.push({ type: "list", ordered: isOrdered, start, items });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !RULE.test(lines[i]) && !/^\s{0,3}>/.test(lines[i]) && !(BULLET.test(lines[i]) || ORDERED.test(lines[i]))) {
      para.push(lines[i].trim());
      i += 1;
    }
    if (para.length === 0) { para.push(line.trim()); i += 1; }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return blocks;
}
