/**
 * Benchmarks for cached session workflows.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import {
  cycleInputs,
  drainSessionEventsCold,
  drainSessionEventsWarm,
  drainSessionLayeredWorkflowCold,
  drainSessionLayeredWorkflowWarm,
  drainSessionOutlineCold,
  drainSessionOutlineWarm,
  drainSessionParseCold,
  drainSessionParseStrictWithDiagnosticsCold,
  drainSessionParseStrictWithDiagnosticsWarm,
  drainSessionParseWithDiagnosticsCold,
  drainSessionParseWithDiagnosticsWarm,
  drainSessionParseWithRecoveryCold,
  drainSessionParseWithRecoveryWarm,
  drainSessionParseWarm,
  SAME_SIZE_MIXED_TEXT,
  SAME_SIZE_PATHOLOGICAL_TEXT,
  SYNTHETIC_ARTICLE_INPUTS,
} from './_test_utils/perf_fixtures.ts';

const nextSyntheticArticle = cycleInputs(SYNTHETIC_ARTICLE_INPUTS);

summary(() => {
  bench('session.outline() cold: mixed ~8 KB', () => {
    do_not_optimize(drainSessionOutlineCold(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('session.outline() warm: mixed ~8 KB', () => {
    do_not_optimize(drainSessionOutlineWarm(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('session.events() cold: mixed ~8 KB', () => {
    do_not_optimize(drainSessionEventsCold(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('session.events() warm: mixed ~8 KB', () => {
    do_not_optimize(drainSessionEventsWarm(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('session.parse() cold: mixed ~8 KB', () => {
    do_not_optimize(drainSessionParseCold(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('session.parse() warm: mixed ~8 KB', () => {
    do_not_optimize(drainSessionParseWarm(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('session.parseWithDiagnostics() cold: pathological ~8 KB', () => {
    do_not_optimize(drainSessionParseWithDiagnosticsCold(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');

  bench('session.parseWithDiagnostics() warm: pathological ~8 KB', () => {
    do_not_optimize(drainSessionParseWithDiagnosticsWarm(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');

  bench('session.parseStrictWithDiagnostics() cold: pathological ~8 KB', () => {
    do_not_optimize(drainSessionParseStrictWithDiagnosticsCold(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');

  bench('session.parseStrictWithDiagnostics() warm: pathological ~8 KB', () => {
    do_not_optimize(drainSessionParseStrictWithDiagnosticsWarm(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');

  bench('session.parseWithRecovery() cold: pathological ~8 KB', () => {
    do_not_optimize(drainSessionParseWithRecoveryCold(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');

  bench('session.parseWithRecovery() warm: pathological ~8 KB', () => {
    do_not_optimize(drainSessionParseWithRecoveryWarm(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');

  bench('consumer workflow: session outline -> events -> parse cold (mixed ~8 KB)', () => {
    do_not_optimize(drainSessionLayeredWorkflowCold(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('consumer workflow: session outline -> events -> parse warm (mixed ~8 KB)', () => {
    do_not_optimize(drainSessionLayeredWorkflowWarm(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench('consumer workflow: session outline -> events -> parse warm (pathological ~8 KB)', () => {
    do_not_optimize(drainSessionLayeredWorkflowWarm(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');
});

summary(() => {
  bench('consumer workflow: session outline -> events -> parse cold synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionLayeredWorkflowCold(nextSyntheticArticle()));
  }).gc('inner');

  bench('consumer workflow: session outline -> events -> parse warm synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionLayeredWorkflowWarm(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.outline() cold: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionOutlineCold(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.outline() warm: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionOutlineWarm(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.events() cold: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionEventsCold(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.events() warm: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionEventsWarm(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.parse() cold: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionParseCold(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.parse() warm: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionParseWarm(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.parseWithDiagnostics() cold: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionParseWithDiagnosticsCold(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.parseWithDiagnostics() warm: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionParseWithDiagnosticsWarm(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.parseStrictWithDiagnostics() cold: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionParseStrictWithDiagnosticsCold(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.parseStrictWithDiagnostics() warm: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionParseStrictWithDiagnosticsWarm(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.parseWithRecovery() cold: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionParseWithRecoveryCold(nextSyntheticArticle()));
  }).gc('inner');

  bench('session.parseWithRecovery() warm: synthetic article (~35-45 KB)', () => {
    do_not_optimize(drainSessionParseWithRecoveryWarm(nextSyntheticArticle()));
  }).gc('inner');
});

await run();