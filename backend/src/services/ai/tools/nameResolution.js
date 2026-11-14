const { HEX24, escapeRegex, guarded, normalizeRef, timed } = require('./toolSupport');

/**
 * Resolves a model-supplied reference (an id or a name) to ONE record inside the caller's AI-visible scope, or says why it cannot.
 *
 *   - An id (24 hex) goes through `findById`, which applies the AI access rules; anything else is a name.
 *   - A name is searched ONLY within `baseFilter` (the AI visibility filter), so nothing outside the user's scope can be matched,
 *     named in an ambiguity list, or even counted.
 *   - Exact name first (case-insensitive, via a collation: no regular expression). Only when there is no exact match is a partial
 *     match tried, with the text ESCAPED so it can only match literally. One partial match is returned as `matchedBy: partial_name`
 *     (the caller can tell the user); several matches of either kind are AMBIGUOUS: nothing is picked.
 *   - `not_found` is one outcome for "no such record", "not yours", "other organization" and a malformed id: indistinguishable.
 *
 * @returns {{ outcome: 'found'|'ambiguous'|'not_found', matchedBy: string|null, record: object|null, candidates: object[] }}
 */
const COLLATION = { locale: 'en', strength: 2 }; // case- and accent-insensitive equality, no regex
const MAX_CANDIDATES = 5;

async function resolveRef({ model, baseFilter, ref, select, findById, signal, maxTimeMs }) {
  const text = normalizeRef(ref);
  const none = { outcome: 'not_found', matchedBy: null, record: null, candidates: [] };
  if (!text) return none;

  if (HEX24.test(text)) {
    const record = await findById(text);
    return record ? { outcome: 'found', matchedBy: 'id', record, candidates: [] } : none;
  }

  const search = (extra) => guarded(signal, () => timed(
    model.find({ $and: [baseFilter, extra] }).collation(COLLATION).sort({ name: 1, _id: 1 }).limit(MAX_CANDIDATES + 1).select(select).lean(),
    maxTimeMs,
  ));

  const exact = await search({ name: text });
  if (exact.length === 1) return { outcome: 'found', matchedBy: 'exact_name', record: exact[0], candidates: [] };
  if (exact.length > 1) return { outcome: 'ambiguous', matchedBy: null, record: null, candidates: exact.slice(0, MAX_CANDIDATES) };

  const partial = await search({ name: { $regex: escapeRegex(text), $options: 'i' } });
  if (partial.length === 1) return { outcome: 'found', matchedBy: 'partial_name', record: partial[0], candidates: [] };
  if (partial.length > 1) return { outcome: 'ambiguous', matchedBy: null, record: null, candidates: partial.slice(0, MAX_CANDIDATES) };
  return none;
}

module.exports = { MAX_CANDIDATES, resolveRef };
