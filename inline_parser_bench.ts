/**
 * Benchmarks for inline parsing and inline helper construction.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import type { WikitextEvent } from './events.ts';

import {
  cycleInputs,
  drainInlineEvents,
  INLINE_HEAVY_TEXT_INPUTS,
  LARGE_STREAMING_ARTICLE_TEXT,
  MIXED_TEXT_INPUTS,
  PATHOLOGICAL_TEXT_INPUTS,
  SAME_SIZE_MIXED_TEXT,
  SAME_SIZE_PATHOLOGICAL_TEXT,
  SYNTHETIC_ARTICLE_INPUTS,
} from './_test_utils/perf_fixtures.ts';
import {
  BARE_URI_ACCEPTANCE_FIXTURES,
  BARE_URI_REJECTION_FIXTURES,
  EXPLICIT_URI_ACCEPTANCE_FIXTURES,
} from './_test_utils/uri_fixtures.ts';
import {
  blockEvents,
  enterEvent,
  errorEvent,
  exitEvent,
  inlineEvents,
  textEvent,
  tokenize,
  tokenEvent,
  TokenType,
} from './mod.ts';

type BenchPoint = {
  line: number;
  column: number;
  offset: number;
};

type BenchPosition = {
  start: BenchPoint;
  end: BenchPoint;
};

type TextGroupContextFixture = {
  text_start: number;
  text_end: number;
  needs_lookbehind: boolean;
  disable_links: boolean;
};

type ReplayState = {
  index: number;
  error_count: number;
};

type ParagraphHandoffState = {
  child_count: number;
  breaks_before: number;
  breaks_after: number;
};

type TextChunkFixture = {
  source: string;
  merged_events: WikitextEvent[];
  fragmented_events: WikitextEvent[];
};

function createBenchPosition(offset: number): BenchPosition {
  return {
    start: {
      line: 1,
      column: offset + 1,
      offset,
    },
    end: {
      line: 1,
      column: offset + 5,
      offset: offset + 4,
    },
  };
}

function createTextGroupContextFixture(
  text_start: number,
  text_end: number,
  needs_lookbehind: boolean,
  disable_links: boolean,
): TextGroupContextFixture {
  return {
    text_start,
    text_end,
    needs_lookbehind,
    disable_links,
  };
}

function createReplayState(index: number, error_count = 0): ReplayState {
  return {
    index,
    error_count,
  };
}

function advanceReplayState(state: ReplayState, step: number): ReplayState {
  return {
    index: state.index + step,
    error_count: state.error_count + Number(step < 0),
  };
}

function createParagraphHandoffState(
  child_count: number,
  breaks_before: number,
  breaks_after: number,
): ParagraphHandoffState {
  return {
    child_count,
    breaks_before,
    breaks_after,
  };
}

function createSingleLinePosition(start_offset: number, end_offset: number): BenchPosition {
  return {
    start: {
      line: 1,
      column: start_offset + 1,
      offset: start_offset,
    },
    end: {
      line: 1,
      column: end_offset + 1,
      offset: end_offset,
    },
  };
}

function createChunkedTextEvents(source: string, chunk_size: number): WikitextEvent[] {
  const events: WikitextEvent[] = [];

  for (let start_offset = 0; start_offset < source.length; start_offset += chunk_size) {
    const end_offset = Math.min(source.length, start_offset + chunk_size);
    events.push(textEvent(start_offset, end_offset, createSingleLinePosition(start_offset, end_offset)));
  }

  return events;
}

function createTextChunkFixture(source: string, chunk_size: number): TextChunkFixture {
  return {
    source,
    merged_events: [textEvent(0, source.length, createSingleLinePosition(0, source.length))],
    fragmented_events: createChunkedTextEvents(source, chunk_size),
  };
}

const POSITION_CASES = [
  createBenchPosition(0),
  createBenchPosition(1),
  createBenchPosition(128),
  createBenchPosition(4096),
] as const;

const TEXT_GROUP_CONTEXT_FIXTURES = [
  createTextGroupContextFixture(0, 32, false, false),
  createTextGroupContextFixture(96, 224, true, false),
  createTextGroupContextFixture(512, 740, true, true),
] as const;

const REPLAY_STATE_FIXTURES = [
  createReplayState(0),
  createReplayState(12),
  createReplayState(128, 1),
] as const;

const PARAGRAPH_HANDOFF_FIXTURES = [
  createParagraphHandoffState(0, 0, 0),
  createParagraphHandoffState(6, 1, 0),
  createParagraphHandoffState(24, 2, 1),
] as const;

const nextPositionCase = cycleInputs(POSITION_CASES);
const nextTextGroupContextFixture = cycleInputs(TEXT_GROUP_CONTEXT_FIXTURES);
const nextReplayStateFixture = cycleInputs(REPLAY_STATE_FIXTURES);
const nextParagraphHandoffFixture = cycleInputs(PARAGRAPH_HANDOFF_FIXTURES);
const nextMixedText = cycleInputs(MIXED_TEXT_INPUTS);
const nextPathologicalText = cycleInputs(PATHOLOGICAL_TEXT_INPUTS);
const nextInlineHeavyText = cycleInputs(INLINE_HEAVY_TEXT_INPUTS);
const nextSyntheticArticle = cycleInputs(SYNTHETIC_ARTICLE_INPUTS);

const HANDOFF_PLAIN_TEXT = [
  'Observational records preserve calibration notes, atmospheric corrections, and cautious prose across many contiguous sentences.',
  'The point of this fixture is to keep the bytes mostly plain text so the inline parser should spend most of its time proving that nothing special needs to happen.',
  'That makes it a useful way to measure the merge cost of fragmented text groups against one already-merged handoff.',
].join(' ')
  .repeat(28);

const HANDOFF_URL_HEAVY_TEXT = [
  'Visit https://example.com/path(test)?q=alpha,beta and then https://example.org/docs/path(testing).',
  'The surrounding prose adds punctuation, commas, and parentheses so the scanner has to do real boundary work instead of only matching the scheme prefix.',
].join(' ')
  .repeat(32);

const URI_ACCEPTANCE_CORPUS = [
  ...BARE_URI_ACCEPTANCE_FIXTURES.map((fixture) => fixture.input),
  ...EXPLICIT_URI_ACCEPTANCE_FIXTURES.map((fixture) => fixture.input),
].join(' ')
  .repeat(28);

const URI_REJECTION_CORPUS = BARE_URI_REJECTION_FIXTURES.join(' ')
  .repeat(56);

const PLAIN_HANDOFF_FIXTURE = createTextChunkFixture(HANDOFF_PLAIN_TEXT, 32);
const URL_HANDOFF_FIXTURE = createTextChunkFixture(HANDOFF_URL_HEAVY_TEXT, 32);

summary(() => {
  bench('inline helper: create position lookup', () => {
    const position = nextPositionCase();
    do_not_optimize(position.start.offset + position.end.offset);
  });

  bench('inline helper: create text group context', () => {
    const fixture = nextTextGroupContextFixture();
    do_not_optimize(
      createTextGroupContextFixture(
        fixture.text_start,
        fixture.text_end,
        fixture.needs_lookbehind,
        fixture.disable_links,
      ),
    );
  });

  bench('inline helper: advance replay state', () => {
    const fixture = nextReplayStateFixture();
    do_not_optimize(advanceReplayState(fixture, 3));
  });

  bench('inline helper: create paragraph handoff state', () => {
    const fixture = nextParagraphHandoffFixture();
    do_not_optimize(
      createParagraphHandoffState(
        fixture.child_count,
        fixture.breaks_before,
        fixture.breaks_after,
      ),
    );
  });
});

summary(() => {
  bench('inline replay: token/text/error event constructors', () => {
    const position = nextPositionCase();
    do_not_optimize(tokenEvent(TokenType.TEXT, position.start.offset, position.end.offset, position));
    do_not_optimize(textEvent(position.start.offset, position.end.offset, position));
    do_not_optimize(errorEvent('invalid-inline', position));
  });

  bench('inline replay: enter/exit event constructors', () => {
    const position = nextPositionCase();
    do_not_optimize(enterEvent('paragraph', {}, position));
    do_not_optimize(exitEvent('paragraph', position));
  });
});

summary(() => {
  bench('inlineEvents: mixed wikitext (7.5 KB)', () => {
    do_not_optimize(drainInlineEvents(nextMixedText()));
  }).gc('inner');

  bench('inlineEvents: pathological delimiters (8-10 KB)', () => {
    do_not_optimize(drainInlineEvents(nextPathologicalText()));
  }).gc('inner');

  bench('inlineEvents: inline-heavy mixed article (9 KB)', () => {
    do_not_optimize(drainInlineEvents(nextInlineHeavyText()));
  }).gc('inner');
});

summary(() => {
  bench('inlineEvents: same-size mixed (~8 KB)', () => {
    do_not_optimize(drainInlineEvents(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('inlineEvents: same-size pathological (~8 KB)', () => {
    do_not_optimize(drainInlineEvents(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');

  bench('inlineEvents: URI acceptance corpus (~8 KB)', () => {
    do_not_optimize(drainInlineEvents(URI_ACCEPTANCE_CORPUS));
  }).gc('inner');

  bench('inlineEvents: URI rejection corpus (~8 KB)', () => {
    do_not_optimize(drainInlineEvents(URI_REJECTION_CORPUS));
  }).gc('inner');
});

summary(() => {
  bench('inlineEvents: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainInlineEvents(nextSyntheticArticle()));
  }).gc('inner');
});

summary(() => {
  bench('inlineEvents: large mixed article (~100 MB)', () => {
    do_not_optimize(drainInlineEvents(LARGE_STREAMING_ARTICLE_TEXT));
  }).gc('inner');
});

summary(() => {
  bench('inline pipeline: replay block events into inline parser (mixed ~8 KB)', () => {
    const source = SAME_SIZE_MIXED_TEXT;
    do_not_optimize(Array.from(inlineEvents(source, blockEvents(source, tokenize(source)))).length);
  }).gc('inner');
});

summary(() => {
  bench('inline handoff: merged plain prose group (~8 KB)', () => {
    do_not_optimize(Array.from(inlineEvents(PLAIN_HANDOFF_FIXTURE.source, PLAIN_HANDOFF_FIXTURE.merged_events)).length);
  }).gc('inner');

  bench('inline handoff: fragmented plain prose groups (~8 KB)', () => {
    do_not_optimize(Array.from(inlineEvents(PLAIN_HANDOFF_FIXTURE.source, PLAIN_HANDOFF_FIXTURE.fragmented_events)).length);
  }).gc('inner');

  bench('inline handoff: merged URL-heavy prose (~8 KB)', () => {
    do_not_optimize(Array.from(inlineEvents(URL_HANDOFF_FIXTURE.source, URL_HANDOFF_FIXTURE.merged_events)).length);
  }).gc('inner');

  bench('inline handoff: fragmented URL-heavy prose (~8 KB)', () => {
    do_not_optimize(Array.from(inlineEvents(URL_HANDOFF_FIXTURE.source, URL_HANDOFF_FIXTURE.fragmented_events)).length);
  }).gc('inner');
});

await run();