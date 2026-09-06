/**
 * Minimal concurrency-limited map — no dependency needed for this.
 *
 * Runs `fn` over every item in `items`, at most `concurrency` calls in
 * flight at once, preserving output order (results[i] corresponds to
 * items[i]) regardless of completion order. If `fn` throws for any item,
 * the returned promise rejects with that error once all in-flight calls
 * settle (it does not abandon already-started work).
 *
 * Used by rotate-encryption-key.mjs and verify-encryption-key.mjs to run
 * PBKDF2 (CPU-bound, and — via the async `crypto.pbkdf2` these scripts use —
 * dispatched to Node's libuv threadpool) for many records at once instead of
 * one at a time. Without this, a 30,000-row model at ~20ms per derivation is
 * a sequential 10+ minutes even after removing redundant derivations; with
 * enough concurrency to actually use the threadpool, it drops to roughly
 * that divided by the concurrency level.
 */
export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (!firstError) firstError = err;
        // Keep going — other in-flight items should still settle rather than
        // being abandoned mid-write; the caller sees the first error either way.
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (firstError) throw firstError;
  return results;
}
