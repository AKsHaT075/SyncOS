/** Citation helpers (pure). Nothing here invents data: it only formats what the backend returned. */

/** Where in the document a passage came from, e.g. "Page 3", "Sheet Q1 · rows 2–9", "Slide 4", "Section A › B". Empty when unknown. */
export function formatLocation(location) {
  if (!location || typeof location !== "object") return "";
  const range = (a, b, word) => (Number.isFinite(a) ? (Number.isFinite(b) && b !== a ? `${word}s ${a}–${b}` : `${word} ${a}`) : "");
  const parts = [];
  if (Array.isArray(location.headingPath) && location.headingPath.length) parts.push(location.headingPath.join(" › "));
  const page = range(location.pageStart, location.pageEnd, "Page");
  if (page) parts.push(page);
  const slide = range(location.slideStart, location.slideEnd, "Slide");
  if (slide) parts.push(slide);
  if (location.sheet) parts.push(`Sheet ${location.sheet}`);
  const rows = range(location.rowStart, location.rowEnd, "Row");
  if (rows) parts.push(rows.replace(/^Row/, "Row"));
  return parts.join(" · ");
}

/** Link to the document in the library. Only for a source the backend says is available; the library re-checks access itself. */
export function documentHref(citation) {
  if (!citation || citation.available === false || !/^[a-f0-9]{24}$/i.test(String(citation.documentId || ""))) return null;
  return `/dashboard/documents?doc=${citation.documentId}`;
}

/** Citations as the UI shows them: stable order by marker number; SSE citations (no `available` flag) are available. */
export function normalizeCitations(citations) {
  if (!Array.isArray(citations)) return [];
  return citations
    .filter((c) => c && Number.isInteger(c.n))
    .map((c) => (c.available === false ? { n: c.n, available: false } : { ...c, available: true }))
    .sort((a, b) => a.n - b.n);
}
