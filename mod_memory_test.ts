/**
 * Memory regression tests for foundational wikitext APIs.
 *
 * These tests catch a specific class of bug: functions on hot paths that
 * accidentally retain memory across repeated calls (e.g., growing an
 * internal cache, leaking closures, or holding references to intermediate
 * objects).
 *
 * The approach:
 * 1. Call the function many times to warm up the JIT compiler.
 * 2. Force garbage collection, then measure heap usage.
 * 3. Call the function many more times, force GC again, measure again.
 * 4. If the heap grew significantly between the two measurements,
 *    something is retaining memory.
 *
 * These tests require the `--v8-flags=--expose-gc` flag (set in
 * `deno task test`) to enable manual garbage collection. Without it,
 * the tests still run but the heap measurements are skipped.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';

import {
  TokenType,
  enterEvent,
  errorEvent,
  exitEvent,
  isToken,
  textEvent,
  tokenEvent,
} from './mod.ts';

/** A minimal Position object for constructing events in the tests. */
const pos = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 5, offset: 4 },
} as const;

/**
 * Read the current heap usage in bytes.
 *
 * Tries Deno first, then Node.js, then returns null if neither is
 * available. The `null` case means the test environment doesn't support
 * heap measurement, so memory assertions are safely skipped.
 */
function readHeapUsedBytes(): number | null {
  const maybeDeno = globalThis as unknown as {
    Deno?: { memoryUsage?: () => { heapUsed: number } };
  };
  if (typeof maybeDeno.Deno?.memoryUsage === 'function') {
    return maybeDeno.Deno.memoryUsage().heapUsed;
  }

  const maybeProcess = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
  };
  if (typeof maybeProcess.process?.memoryUsage === 'function') {
    return maybeProcess.process.memoryUsage().heapUsed;
  }

  return null;
}

/**
 * Force garbage collection if the `gc()` global is available.
 *
 * The test runner uses `--v8-flags=--expose-gc` to make `globalThis.gc`
 * available. We call it three times to ensure weak references are cleared
 * and finalizers run, giving the most stable heap measurements.
 */
function forceGCIfAvailable(): void {
  const maybeGlobal = globalThis as unknown as { gc?: () => void };
  if (typeof maybeGlobal.gc === 'function') {
    maybeGlobal.gc();
    maybeGlobal.gc();
    maybeGlobal.gc();
  }
}

/**
 * Assert that calling `fn` repeatedly does not cause unbounded heap growth.
 *
 * Algorithm:
 * 1. Warm up with `warmupCount` calls (lets the JIT optimize).
 * 2. Run `iterCount` calls, then GC and snapshot the heap ("after1").
 * 3. Run `iterCount` calls again, GC and snapshot ("after2").
 * 4. If `after2 - after1` exceeds `thresholdKB`, the function is leaking.
 *
 * @param fn - The function to test for memory leaks.
 * @param iterCount - Number of calls per measurement phase.
 * @param thresholdKB - Maximum allowed heap growth in KiB.
 * @param warmupCount - Number of warmup calls before measuring.
 */
function assertNoLeak(
  fn: () => void,
  iterCount = 10_000,
  thresholdKB = 512,
  warmupCount = 1_000,
): void {
  // Warm up first so the comparison is not polluted by JIT compilation or one-
  // time runtime setup. We want to catch retained memory, not startup cost.
  for (let i = 0; i < warmupCount; i++) fn();
  forceGCIfAvailable();

  for (let i = 0; i < iterCount; i++) fn();
  forceGCIfAvailable();
  const after1 = readHeapUsedBytes();

  // Repeating the same workload after the first stabilized measurement makes a
  // second-growth delta much more suspicious. By this point, transient setup
  // objects should already be gone if nothing is leaking.
  for (let i = 0; i < iterCount; i++) fn();
  forceGCIfAvailable();
  const after2 = readHeapUsedBytes();

  if (after1 === null || after2 === null) return;
  const deltaKB = (after2 - after1) / 1024;
  expect(deltaKB).toBeLessThan(thresholdKB);
}

describe('memory regression', () => {
  it('isToken() does not retain memory across repeated checks', () => {
    const valid = { type: TokenType.TEXT, start: 0, end: 4 };
    assertNoLeak(() => {
      isToken(valid);
    });
  });

  it('event constructors do not retain memory on hot paths', () => {
    assertNoLeak(() => {
      enterEvent('paragraph', {}, pos);
      textEvent(0, 4, pos);
      tokenEvent(TokenType.TEXT, 0, 4, pos);
      errorEvent('Recoverable parse point', pos, {
        severity: 'warning',
        recoverable: true,
        source: 'inline',
        code: 'INLINE_RECOVERY',
      });
      exitEvent('paragraph', pos);
    }, 10_000, 1024);
  });
});
