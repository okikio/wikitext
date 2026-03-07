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
  blockEvents,
  TokenType,
  enterEvent,
  errorEvent,
  exitEvent,
  inlineEvents,
  isToken,
  textEvent,
  tokenEvent,
  tokenize,
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

// --- Tokenizer benchmarks ---
// The tokenizer is the hottest path in the parser pipeline:
// it scans every character of the input. These benchmarks measure
// throughput on representative wikitext inputs.

const PLAIN_TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(200);
const HEADING_TEXT = '== Section ==\nParagraph text here.\n'.repeat(100);
const TABLE_TEXT = '{|\n! H1 !! H2\n|-\n| A || B\n|-\n| C || D\n|}\n'.repeat(50);
const LINK_TEXT = "See [[Main Page|home]], '''bold''' and ''italic'' text.\n".repeat(100);
const TEMPLATE_TEXT = '{{Infobox|name={{{1}}}|value={{{2|default}}}}}\n'.repeat(100);
const MIXED_TEXT = [
  '== Heading ==',
  "'''Bold''' and ''italic'' and '''''both'''''.",
  '* Bullet item',
  '# Ordered item',
  ': Indented',
  '{|',
  '! Header',
  '|-',
  '| [[Page|link]] || {{template|arg=val}}',
  '|}',
  '----',
  '<!-- comment -->',
  '&amp; &#123; &#x1F4A9;',
  '~~~~ __TOC__',
  '',
].join('\n').repeat(50);

/** Drain a generator, returning the token count to prevent dead-code elimination. */
function drainTokenize(input: string): number {
  let count = 0;
  for (const _tok of tokenize(input)) {
    count++;
  }
  return count;
}

/** Drain block events so benchmarks measure parsing work, not lazy iteration setup. */
function drainBlockEvents(input: string): number {
  let count = 0;
  for (const _event of blockEvents(input, tokenize(input))) {
    count++;
  }
  return count;
}

/** Drain inline-enriched events over the full tokenizer -> block -> inline path. */
function drainInlineEvents(input: string): number {
  let count = 0;
  for (const _event of inlineEvents(input, blockEvents(input, tokenize(input)))) {
    count++;
  }
  return count;
}

summary(() => {
  bench('tokenize: plain text (9 KB)', () => {
    do_not_optimize(drainTokenize(PLAIN_TEXT));
  }).gc('inner');

  bench('tokenize: headings + paragraphs (3 KB)', () => {
    do_not_optimize(drainTokenize(HEADING_TEXT));
  }).gc('inner');

  bench('tokenize: tables (3.5 KB)', () => {
    do_not_optimize(drainTokenize(TABLE_TEXT));
  }).gc('inner');

  bench('tokenize: links + bold/italic (5.5 KB)', () => {
    do_not_optimize(drainTokenize(LINK_TEXT));
  }).gc('inner');

  bench('tokenize: templates + arguments (4.6 KB)', () => {
    do_not_optimize(drainTokenize(TEMPLATE_TEXT));
  }).gc('inner');

  bench('tokenize: mixed wikitext (7.5 KB)', () => {
    do_not_optimize(drainTokenize(MIXED_TEXT));
  }).gc('inner');
});

// --- Event pipeline benchmarks ---
// These measure the stages we actually added in Phases 3 and 4. Using the
// same inputs across token-only, block, and inline runs makes it easier to see
// where additional event-layer cost is coming from.

const INLINE_HEAVY_TEXT = [
  '== References ==',
  "A [[Main Page|home]] link with ''italic'', '''bold''', and '''''both'''''.",
  '<ref name="cite-1" group="note">Example &amp; entity</ref>',
  '<span class="lead">inline tag</span> and <br/> break.',
  '__TOC__ {{Infobox|name=value|title={{{1|Default}}}}}',
  'A <nowiki>[[literal]] {{literal}}</nowiki> segment.',
  '',
].join('\n').repeat(80);

summary(() => {
  bench('blockEvents: plain text (9 KB)', () => {
    do_not_optimize(drainBlockEvents(PLAIN_TEXT));
  }).gc('inner');

  bench('blockEvents: mixed wikitext (7.5 KB)', () => {
    do_not_optimize(drainBlockEvents(MIXED_TEXT));
  }).gc('inner');

  bench('inlineEvents: mixed wikitext (7.5 KB)', () => {
    do_not_optimize(drainInlineEvents(MIXED_TEXT));
  }).gc('inner');

  bench('inlineEvents: inline-heavy wikitext (16 KB)', () => {
    do_not_optimize(drainInlineEvents(INLINE_HEAVY_TEXT));
  }).gc('inner');
});

await run();
