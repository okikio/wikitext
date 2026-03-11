/**
 * Benchmarks for the block parser layer.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import {
  cycleInputs,
  drainBlockEvents,
  LARGE_STREAMING_ARTICLE_TEXT,
  MIXED_TEXT_INPUTS,
  PATHOLOGICAL_TEXT_INPUTS,
  PLAIN_TEXT_INPUTS,
  SAME_SIZE_MIXED_TEXT,
  SAME_SIZE_PATHOLOGICAL_TEXT,
  SAME_SIZE_PLAIN_TEXT,
  SYNTHETIC_ARTICLE_INPUTS,
} from './_test_utils/perf_fixtures.ts';

const nextPlainText = cycleInputs(PLAIN_TEXT_INPUTS);
const nextMixedText = cycleInputs(MIXED_TEXT_INPUTS);
const nextPathologicalText = cycleInputs(PATHOLOGICAL_TEXT_INPUTS);
const nextSyntheticArticle = cycleInputs(SYNTHETIC_ARTICLE_INPUTS);

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
  bench('blockEvents: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainBlockEvents(nextSyntheticArticle()));
  }).gc('inner');
});

summary(() => {
  bench('blockEvents: large mixed article (~100 MB)', () => {
    do_not_optimize(drainBlockEvents(LARGE_STREAMING_ARTICLE_TEXT));
  }).gc('inner');
});

await run();