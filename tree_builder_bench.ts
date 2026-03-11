/**
 * Benchmarks for tree materialization.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import {
  createOutlineTreeBuildFixture,
  createTreeBuildFixture,
  cycleInputs,
  drainBuildTreeFromEvents,
  drainBuildTreeFromOutline,
  SAME_SIZE_MIXED_TEXT,
  SYNTHETIC_ARTICLE_INPUTS,
} from './_test_utils/perf_fixtures.ts';

const SAME_SIZE_TREE_FIXTURE = createTreeBuildFixture(SAME_SIZE_MIXED_TEXT);
const SAME_SIZE_OUTLINE_TREE_FIXTURE = createOutlineTreeBuildFixture(SAME_SIZE_MIXED_TEXT);

const TREE_BUILD_FIXTURES = SYNTHETIC_ARTICLE_INPUTS.map(createTreeBuildFixture);
const OUTLINE_TREE_BUILD_FIXTURES = SYNTHETIC_ARTICLE_INPUTS.map(createOutlineTreeBuildFixture);
const nextTreeBuildFixture = cycleInputs(TREE_BUILD_FIXTURES);
const nextOutlineTreeBuildFixture = cycleInputs(OUTLINE_TREE_BUILD_FIXTURES);

summary(() => {
  bench('buildTree: same-size mixed (~8 KB)', () => {
    do_not_optimize(drainBuildTreeFromEvents(SAME_SIZE_TREE_FIXTURE));
  }).gc('inner');

  bench('buildTree(outline): same-size mixed (~8 KB)', () => {
    do_not_optimize(drainBuildTreeFromOutline(SAME_SIZE_OUTLINE_TREE_FIXTURE));
  }).gc('inner');
});

summary(() => {
  bench('buildTree: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainBuildTreeFromEvents(nextTreeBuildFixture()));
  }).gc('inner');

  bench('buildTree(outline): synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainBuildTreeFromOutline(nextOutlineTreeBuildFixture()));
  }).gc('inner');
});

await run();