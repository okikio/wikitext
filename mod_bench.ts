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

/**
 * Rotate through a small fixed input set so the JIT cannot fully specialize on
 * one exact literal across the whole benchmark run.
 */
function cycleInputs<T>(inputs: readonly T[]): () => T {
  let index = 0;

  return () => {
    const input = inputs[index];
    index = (index + 1) % inputs.length;
    return input;
  };
}

/** Repeat a multi-line benchmark unit without measuring string assembly. */
function repeatBlock(unit: string, repeat: number): string {
  return unit.repeat(repeat);
}

/** Minimal state shape used by mitata parameterized benchmarks in this file. */
type RangeState = {
  get(name: string): number;
};

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

const PLAIN_TEXT_INPUTS = [
  'The quick brown fox jumps over the lazy dog. '.repeat(200),
  'Pack my box with five dozen liquor jugs. '.repeat(190),
  'Sphinx of black quartz, judge my vow. '.repeat(205),
] as const;
const HEADING_TEXT_INPUTS = [
  '== Section ==\nParagraph text here.\n'.repeat(100),
  '=== Nested ===\nAnother paragraph line.\n'.repeat(90),
] as const;
const TABLE_TEXT_INPUTS = [
  '{|\n! H1 !! H2\n|-\n| A || B\n|-\n| C || D\n|}\n'.repeat(50),
  '{| class="wikitable"\n! Name !! Value\n|-\n| Alpha || 1\n|-\n| Beta || 2\n|}\n'.repeat(40),
] as const;
const LINK_TEXT_INPUTS = [
  "See [[Main Page|home]], '''bold''' and ''italic'' text.\n".repeat(100),
  'Visit [[Earth|planet]] with [https://example.com source] and &amp; notes.\n'.repeat(80),
] as const;
const TEMPLATE_TEXT_INPUTS = [
  '{{Infobox|name={{{1}}}|value={{{2|default}}}}}\n'.repeat(100),
  '{{Card|title={{PAGENAME}}|body={{{content|fallback}}}}}\n'.repeat(85),
] as const;
const MIXED_TEXT_INPUTS = [
  [
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
  ].join('\n').repeat(50),
  [
    '== Another Heading ==',
    "A [[Main Page|home]] link with ''italic'' and '''bold'''.",
    '; Term',
    ': Definition',
    '{|',
    '! Name !! Count',
    '|-',
    '| {{Item|name=Alpha}} || 42',
    '|}',
    '<span class="lead">inline</span>',
    '&lt;escaped&gt; ~~ ~~ __TOC__',
    '',
  ].join('\n').repeat(48),
] as const;
const PATHOLOGICAL_TEXT_INPUTS = [
  [
    '[[[[{{{{<!--',
    '__BROKEN_',
    '<ref name="n">',
    "'''''",
    '&broken',
    '```md',
    '{|',
    '|-',
    '| [[Page|{{T|x}}]] || <span class="x">text',
    '',
  ].join('\n').repeat(70),
  [
    '{{{{{{',
    '[[File:Example.jpg|thumb|{{Card|name=[[Main Page|home]]}}]]',
    '<nowiki>[[literal]] {{literal}}</nowiki>',
    '<!-- unclosed comment opener',
    '~~~~ __BROKEN_',
    '|| !! | |}',
    '',
  ].join('\n').repeat(55),
] as const;

const nextPlainText = cycleInputs(PLAIN_TEXT_INPUTS);
const nextHeadingText = cycleInputs(HEADING_TEXT_INPUTS);
const nextTableText = cycleInputs(TABLE_TEXT_INPUTS);
const nextLinkText = cycleInputs(LINK_TEXT_INPUTS);
const nextTemplateText = cycleInputs(TEMPLATE_TEXT_INPUTS);
const nextMixedText = cycleInputs(MIXED_TEXT_INPUTS);
const nextPathologicalText = cycleInputs(PATHOLOGICAL_TEXT_INPUTS);

// --- Size-normalized and article-like scenarios ---
// The earlier groups mix both syntax complexity and byte size. These units keep
// the scenarios closer in total size so the next benchmark run can answer a
// narrower question: how much work comes from structure, not just input length?

const SAME_SIZE_PLAIN_TEXT = repeatBlock(
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.\n',
  96,
);
const SAME_SIZE_MIXED_TEXT = repeatBlock([
  '== Heading ==',
  "A [[Main Page|home]] link with ''italic'' and '''bold'''.",
  '* Bullet item',
  '{|',
  '! Header !! Count',
  '|-',
  '| {{Item|name=Alpha}} || 42',
  '|}',
  '&amp; __TOC__',
  '',
].join('\n'), 24);
const SAME_SIZE_PATHOLOGICAL_TEXT = repeatBlock([
  '[[[[{{{{<!--',
  '__BROKEN_',
  '<ref name="n">',
  "'''''",
  '&broken',
  '```md',
  '{|',
  '| [[Page|{{T|x}}]] || <span class="x">text',
  '',
].join('\n'), 30);

const SYNTHETIC_ARTICLE_INPUTS = [
  repeatBlock([
    '{{Infobox settlement|name=Example City|population_total=123456|map={{Location map|World}}}}',
    '== Lead ==',
    "Example City is a ''fictional'' place with [[Main Page|notable links]], references, and templates.",
    '== History ==',
    '* Founded in 1901',
    '* Expanded with {{Convert|25|km|mi}} of rail',
    '== Geography ==',
    '{| class="wikitable"',
    '! District !! Population',
    '|-',
    '| North || 42000',
    '|-',
    '| South || 38000',
    '|}',
    '== Culture ==',
    '<ref name="cite-1">A cited note with &amp; entity</ref>',
    '<span class="lead">Inline tag</span> with __TOC__ and <br/> break.',
    '',
  ].join('\n'), 48),
  repeatBlock([
    '{{Infobox person|name=Example Person|occupation=Writer|known_for=[[Sample work]]}}',
    '== Summary ==',
    "Example Person wrote about [[Earth|the world]], ''style'', and '''emphasis'''.",
    '== Works ==',
    '# First book',
    '# Second book with {{Smallcaps|Title}}',
    '== Notes ==',
    '; Theme',
    ': Mixed prose with [https://example.com source] and <ref group="note">footnote</ref>.',
    '== Data ==',
    '{| class="wikitable"',
    '! Year !! Work',
    '|-',
    '| 2001 || [[Alpha]]',
    '|-',
    '| 2007 || [[Beta]]',
    '|}',
    '',
  ].join('\n'), 52),
] as const;
const nextSyntheticArticle = cycleInputs(SYNTHETIC_ARTICLE_INPUTS);

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
    do_not_optimize(drainTokenize(nextPlainText()));
  }).gc('inner');

  bench('tokenize: headings + paragraphs (3 KB)', () => {
    do_not_optimize(drainTokenize(nextHeadingText()));
  }).gc('inner');

  bench('tokenize: tables (3.5 KB)', () => {
    do_not_optimize(drainTokenize(nextTableText()));
  }).gc('inner');

  bench('tokenize: links + bold/italic (5.5 KB)', () => {
    do_not_optimize(drainTokenize(nextLinkText()));
  }).gc('inner');

  bench('tokenize: templates + arguments (4.6 KB)', () => {
    do_not_optimize(drainTokenize(nextTemplateText()));
  }).gc('inner');

  bench('tokenize: mixed wikitext (7.5 KB)', () => {
    do_not_optimize(drainTokenize(nextMixedText()));
  }).gc('inner');

  bench('tokenize: pathological delimiters (8-10 KB)', () => {
    do_not_optimize(drainTokenize(nextPathologicalText()));
  }).gc('inner');
});

summary(() => {
  bench('tokenize: same-size plain (~8 KB)', () => {
    do_not_optimize(drainTokenize(SAME_SIZE_PLAIN_TEXT));
  }).gc('inner');

  bench('tokenize: same-size mixed (~8 KB)', () => {
    do_not_optimize(drainTokenize(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('tokenize: same-size pathological (~8 KB)', () => {
    do_not_optimize(drainTokenize(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');
});

summary(() => {
  bench('tokenize: mixed scaling ($repeat blocks)', function* (state: RangeState) {
    const repeat = state.get('repeat');

    yield {
      [0]() {
        return repeatBlock([
          '== Heading ==',
          "A [[Main Page|home]] link with ''italic'' and '''bold'''.",
          '* Bullet item',
          '{|',
          '! Header !! Count',
          '|-',
          '| {{Item|name=Alpha}} || 42',
          '|}',
          '&amp; __TOC__',
          '',
        ].join('\n'), repeat);
      },

      bench(input: string) {
        do_not_optimize(drainTokenize(input));
      },
    };
  }).range('repeat', 4, 256).gc('inner');
});

// --- Event pipeline benchmarks ---
// These measure the stages we actually added in Phases 3 and 4. Using the
// same inputs across token-only, block, and inline runs makes it easier to see
// where additional event-layer cost is coming from.

const INLINE_HEAVY_TEXT_INPUTS = [
  [
    '== References ==',
    "A [[Main Page|home]] link with ''italic'', '''bold''', and '''''both'''''.",
    '<ref name="cite-1" group="note">Example &amp; entity</ref>',
    '<span class="lead">inline tag</span> and <br/> break.',
    '__TOC__ {{Infobox|name=value|title={{{1|Default}}}}}',
    'A <nowiki>[[literal]] {{literal}}</nowiki> segment.',
    '',
  ].join('\n').repeat(80),
  [
    '== Inline ==',
    '[[Main Page|home]] [https://example.com ref] {{Card|name=value|body=<span>ok</span>}}',
    '<ref name="cite-2">\'\'quoted\'\' &amp; entity</ref>',
    'A <nowiki>[[literal]]</nowiki> block with __TOC__ nearby.',
    '',
  ].join('\n').repeat(90),
] as const;

const nextInlineHeavyText = cycleInputs(INLINE_HEAVY_TEXT_INPUTS);

summary(() => {
  bench('blockEvents: plain text (9 KB)', () => {
    do_not_optimize(drainBlockEvents(nextPlainText()));
  }).gc('inner');

  bench('blockEvents: mixed wikitext (7.5 KB)', () => {
    do_not_optimize(drainBlockEvents(nextMixedText()));
  }).gc('inner');

  bench('blockEvents: pathological delimiters (8-10 KB)', () => {
    do_not_optimize(drainBlockEvents(nextPathologicalText()));
  }).gc('inner');

  bench('inlineEvents: mixed wikitext (7.5 KB)', () => {
    do_not_optimize(drainInlineEvents(nextMixedText()));
  }).gc('inner');

  bench('inlineEvents: inline-heavy wikitext (16 KB)', () => {
    do_not_optimize(drainInlineEvents(nextInlineHeavyText()));
  }).gc('inner');

  bench('inlineEvents: pathological delimiters (8-10 KB)', () => {
    do_not_optimize(drainInlineEvents(nextPathologicalText()));
  }).gc('inner');
});

summary(() => {
  bench('blockEvents: same-size plain (~8 KB)', () => {
    do_not_optimize(drainBlockEvents(SAME_SIZE_PLAIN_TEXT));
  }).gc('inner');

  bench('blockEvents: same-size mixed (~8 KB)', () => {
    do_not_optimize(drainBlockEvents(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('blockEvents: same-size pathological (~8 KB)', () => {
    do_not_optimize(drainBlockEvents(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');
});

summary(() => {
  bench('inlineEvents: same-size mixed (~8 KB)', () => {
    do_not_optimize(drainInlineEvents(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('inlineEvents: same-size pathological (~8 KB)', () => {
    do_not_optimize(drainInlineEvents(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');
});

summary(() => {
  bench('inlineEvents: mixed scaling ($repeat blocks)', function* (state: RangeState) {
    const repeat = state.get('repeat');

    yield {
      [0]() {
        return repeatBlock([
          '== Heading ==',
          "A [[Main Page|home]] link with ''italic'' and '''bold'''.",
          '* Bullet item',
          '{|',
          '! Header !! Count',
          '|-',
          '| {{Item|name=Alpha}} || 42',
          '|}',
          '&amp; __TOC__',
          '',
        ].join('\n'), repeat);
      },

      bench(input: string) {
        do_not_optimize(drainInlineEvents(input));
      },
    };
  }).range('repeat', 4, 256).gc('inner');

  bench('inlineEvents: pathological scaling ($repeat blocks)', function* (state: RangeState) {
    const repeat = state.get('repeat');

    yield {
      [0]() {
        return repeatBlock([
          '[[[[{{{{<!--',
          '__BROKEN_',
          '<ref name="n">',
          "'''''",
          '&broken',
          '```md',
          '{|',
          '| [[Page|{{T|x}}]] || <span class="x">text',
          '',
        ].join('\n'), repeat);
      },

      bench(input: string) {
        do_not_optimize(drainInlineEvents(input));
      },
    };
  }).range('repeat', 4, 256).gc('inner');
});

summary(() => {
  bench('tokenize: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainTokenize(nextSyntheticArticle()));
  }).gc('inner');

  bench('blockEvents: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainBlockEvents(nextSyntheticArticle()));
  }).gc('inner');

  bench('inlineEvents: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainInlineEvents(nextSyntheticArticle()));
  }).gc('inner');
});

await run();
