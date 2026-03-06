/**
 * Benchmarks for foundational wikitext types.
 *
 * These benchmarks measure the raw cost of the most frequently called
 * operations: the `isToken()` type guard and the five event constructors.
 * They establish a baseline so future changes that regress hot-path
 * performance are caught immediately.
 *
 * Uses [mitata](https://github.com/nicolo-ribaudo/mitata) as the
 * benchmark harness. Key rule: every benchmark must wrap its result in
 * `do_not_optimize()` to prevent V8's JIT from eliminating dead code
 * (a common source of misleadingly fast numbers).
 *
 * Run:
 * ```sh
 * deno bench --allow-env=NODE_DISABLE_COLORS --v8-flags=--expose-gc mod_bench.ts
 * ```
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import {
  bench,
  do_not_optimize,
  run,
  summary,
} from 'npm:mitata';

import {
  TokenType,
  enterEvent,
  errorEvent,
  exitEvent,
  isToken,
  textEvent,
  tokenEvent,
} from './mod.ts';

/** A minimal Position for benchmarks. */
const pos = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 5, offset: 4 },
} as const;

/** A valid token: isToken() should return true for this. */
const validToken = { type: TokenType.TEXT, start: 0, end: 4 };
/** An invalid token: type is not a known TokenType value. */
const invalidToken = { type: 'UNKNOWN', start: 0, end: 4 };

// --- Type guard benchmarks ---
// isToken() is called on every token in the stream by downstream
// consumers. It must be fast (sub-nanosecond on modern hardware).
summary(() => {
  bench('isToken(valid)', () => {
    do_not_optimize(isToken(validToken));
  });

  bench('isToken(invalid)', () => {
    do_not_optimize(isToken(invalidToken));
  });
});

// --- Event constructor benchmarks ---
// Event constructors are called once per event in the stream. For a large
// article producing 100K+ events, even small per-call costs add up.
summary(() => {
  bench('enterEvent()', () => {
    do_not_optimize(enterEvent('paragraph', {}, pos));
  });

  bench('exitEvent()', () => {
    do_not_optimize(exitEvent('paragraph', pos));
  });

  bench('textEvent()', () => {
    do_not_optimize(textEvent(0, 4, pos));
  });

  bench('tokenEvent()', () => {
    do_not_optimize(tokenEvent(TokenType.TEXT, 0, 4, pos));
  });

  bench('errorEvent()', () => {
    do_not_optimize(errorEvent('Malformed inline run', pos));
  });
});

await run();
