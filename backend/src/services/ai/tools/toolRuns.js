/**
 * The tool executions that are running RIGHT NOW in this process, by request. When a request ends (the user stopped it, the
 * connection dropped, it failed) the pipeline aborts everything still running for it, so no query keeps working for an
 * answer nobody is waiting for. Each run also has its own deadline; this registry is the "request is over" half of cancellation.
 *
 * In-process by design: the run lives in the process that received the callback. Across instances the Redis in-flight check
 * stops NEW callbacks, and each run's own deadline bounds a run that was started on another instance.
 */
const runs = new Map(); // requestKey -> Set<AbortController>

function track(requestKey, controller) {
  if (!runs.has(requestKey)) runs.set(requestKey, new Set());
  runs.get(requestKey).add(controller);
  return () => {
    const set = runs.get(requestKey);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) runs.delete(requestKey);
  };
}

/** Aborts every running tool of the request. Returns how many were aborted. */
function abortRequest(requestKey) {
  const set = runs.get(requestKey);
  if (!set) return 0;
  let n = 0;
  for (const controller of set) {
    if (!controller.signal.aborted) {
      controller.abort();
      n += 1;
    }
  }
  return n;
}

const activeCount = () => [...runs.values()].reduce((sum, set) => sum + set.size, 0); // diagnostics / tests

module.exports = { abortRequest, activeCount, track };
