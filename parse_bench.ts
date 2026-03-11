/**
 * Benchmarks for parse orchestration and stateless end-to-end workflows.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import {
  cycleInputs,
  drainStatelessLayeredWorkflow,
  SAME_SIZE_MIXED_TEXT,
  SAME_SIZE_PATHOLOGICAL_TEXT,
  SAME_SIZE_PLAIN_TEXT,
  SYNTHETIC_ARTICLE_INPUTS,
  UNICODE_BENCH_FIXTURES,
} from './_test_utils/perf_fixtures.ts';
import { parse } from './mod.ts';

const nextSyntheticArticle = cycleInputs(SYNTHETIC_ARTICLE_INPUTS);

summary(() => {
  bench('parse(): same-size plain (~8 KB)', () => {
    do_not_optimize(parse(SAME_SIZE_PLAIN_TEXT).children.length);
  }).gc('inner');

  bench('parse(): same-size mixed (~8 KB)', () => {
    do_not_optimize(parse(SAME_SIZE_MIXED_TEXT).children.length);
  }).gc('inner');

  bench('parse(): same-size pathological (~8 KB)', () => {
    do_not_optimize(parse(SAME_SIZE_PATHOLOGICAL_TEXT).children.length);
  }).gc('inner');

  bench('consumer workflow: stateless outline -> events -> parse (mixed ~8 KB)', () => {
    do_not_optimize(drainStatelessLayeredWorkflow(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('consumer workflow: stateless outline -> events -> parse (pathological ~8 KB)', () => {
    do_not_optimize(drainStatelessLayeredWorkflow(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');

  for (const fixture of UNICODE_BENCH_FIXTURES) {
    bench(`parse(): unicode ${fixture.key} document (~8 KB)`, () => {
      do_not_optimize(parse(fixture.document_input).children.length);
    }).gc('inner');
  }
});

summary(() => {
  bench('parse(): synthetic article (~35-45 KB)', () => {
    do_not_optimize(parse(nextSyntheticArticle()).children.length);
  }).gc('inner');

  bench('consumer workflow: stateless outline -> events -> parse synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainStatelessLayeredWorkflow(nextSyntheticArticle()));
  }).gc('inner');
});

await run();