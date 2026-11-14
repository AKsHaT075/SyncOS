/**
 * Minimal Server-Sent-Events reader for a fetch() response body.
 * Yields the `data:` payload of each event as a string; stops at `[DONE]`.
 * Cancellation and timeouts are the caller's job (it aborts the fetch signal,
 * which makes reader.read() reject).
 *
 * `onKeepalive` is called for the comment line `: keepalive` and for NOTHING else: that exact line is Python's proof of life while a model call is
 * in flight (a tool-enabled answer is buffered, so no data frames flow). Any other comment is ignored and never counts as activity.
 */
const KEEPALIVE = ': keepalive';

async function* readSse(body, { onKeepalive } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      // Events end with a blank line; tolerate \r\n.
      while ((boundary = findBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = extractData(raw);
        if (data === null) {
          if (raw.trim() === KEEPALIVE) onKeepalive?.();
          continue;
        }
        if (data === '[DONE]') return;
        yield data;
      }
    }
    buffer += decoder.decode();
    const tail = extractData(buffer);
    if (tail !== null && tail !== '[DONE]') yield tail;
  } finally {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* already closed */
    }
  }
}

function findBoundary(text) {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function extractData(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? data.join('\n') : null;
}

module.exports = { readSse };
