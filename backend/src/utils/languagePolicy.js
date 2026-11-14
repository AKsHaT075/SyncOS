/**
 * Language policy for AI knowledge retrieval (v1): ENGLISH ONLY.
 *
 * The embedding model and the evaluation set do not support reliable Hindi/Punjabi retrieval, so a question written in
 * another script gets a clear fixed reply instead of an unreliable answer. This is a SCRIPT check at the question boundary,
 * not language identification: romanized Hindi ("chutti kitni milti hai") and other Latin-script languages (French, Spanish)
 * look like English to it and are not detected. Those questions simply tend to find nothing and get the "not found" answer.
 */
const NON_ENGLISH_RATIO = 0.3; // share of letters outside the Latin script above which the question is refused

const UNSUPPORTED_LANGUAGE_MESSAGE =
  'Sync OS AI knowledge search currently supports questions in English only. Please ask your question in English.';

function isSupportedLanguage(text) {
  const letters = String(text).match(/\p{L}/gu) || [];
  if (letters.length === 0) return true; // digits / symbols only: nothing to judge, retrieval will simply find nothing
  const latin = (String(text).match(/\p{Script=Latin}/gu) || []).length;
  return (letters.length - latin) / letters.length <= NON_ENGLISH_RATIO;
}

module.exports = { UNSUPPORTED_LANGUAGE_MESSAGE, isSupportedLanguage };
