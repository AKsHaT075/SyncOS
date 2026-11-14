/**
 * Incremental Server-Sent-Events parser (pure). Feed it text chunks; it returns the complete events seen so far and keeps the
 * unfinished remainder for the next chunk. Comments (": ping") and unknown fields are ignored; malformed JSON data is skipped.
 */
export function createSseParser() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      const events = [];
      for (const block of blocks) {
        let name = "message";
        const data = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length === 0) continue;
        try {
          events.push({ event: name, data: JSON.parse(data.join("\n")) });
        } catch {
          /* skip a malformed event */
        }
      }
      return events;
    },
    /** True when a partial event is buffered (the stream ended mid-event). */
    get pending() {
      return buffer.trim().length > 0;
    },
  };
}
