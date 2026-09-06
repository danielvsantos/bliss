import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../../scripts/lib/concurrency.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const items = [30, 10, 20]; // deliberately out of completion order
    const results = await mapWithConcurrency(items, 3, async (ms) => {
      await delay(ms);
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 47 }, (_, i) => i);
    const seen = [];
    const results = await mapWithConcurrency(items, 5, async (n) => {
      seen.push(n);
      return n * 2;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(results).toEqual(items.map((n) => n * 2));
  });

  it('never runs more than `concurrency` calls at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // proves it's actually concurrent, not accidentally serial
  });

  it('caps concurrency at the item count when concurrency exceeds it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], 100, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('propagates a thrown error after letting other in-flight items settle', async () => {
    const items = [1, 2, 3, 4];
    const completed = [];
    await expect(
      mapWithConcurrency(items, 2, async (n) => {
        if (n === 2) throw new Error(`boom on ${n}`);
        await delay(5);
        completed.push(n);
        return n;
      })
    ).rejects.toThrow('boom on 2');
    // items 1 and 3/4 (whichever were in flight) still ran to completion
    expect(completed.length).toBeGreaterThan(0);
  });

  it('handles an empty item list', async () => {
    const results = await mapWithConcurrency([], 5, async () => 1);
    expect(results).toEqual([]);
  });
});
