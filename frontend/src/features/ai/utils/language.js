/**
 * English-only policy (v1), mirrored from the backend's script check so the user is told BEFORE sending. The backend remains the
 * authority (it applies the same rule to every request): if this ever disagreed, the server's fixed reply is still shown.
 * More than 30% of the letters outside the Latin script => unsupported. Romanized text cannot be detected.
 */
const NON_ENGLISH_RATIO = 0.3;

export function isSupportedLanguage(text) {
  const value = String(text ?? "");
  const letters = value.match(/\p{L}/gu) || [];
  if (letters.length === 0) return true;
  const latin = (value.match(/\p{Script=Latin}/gu) || []).length;
  return (letters.length - latin) / letters.length <= NON_ENGLISH_RATIO;
}

export const UNSUPPORTED_LANGUAGE_HINT =
  "AI knowledge search currently supports English only. Please write your question in English.";
