/**
 * Benchmarks that isolate event representation access patterns.
 *
 * The goal is to make event-shape experiments comparable without changing the
 * parser pipeline or mixing ad-hoc memory checks into hot loops.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import {
	cycleInputs,
	drainEnterProps,
	drainEventsNoPosition,
	drainEventsOffsetsOnly,
	drainEventsWithPosition,
	drainRetainedEventCount,
	drainSessionEventsCold,
	drainSessionEventsWarm,
	drainSessionParseCold,
	drainSessionParseWarm,
	drainSessionParseWithDiagnosticsCold,
	drainSessionParseWithDiagnosticsWarm,
	drainSessionRetainedEventCountWarm,
	drainStatelessParseWithDiagnostics,
	SAME_SIZE_MIXED_TEXT,
	SAME_SIZE_PATHOLOGICAL_TEXT,
	SAME_SIZE_PLAIN_TEXT,
	SYNTHETIC_ARTICLE_INPUTS,
} from './_test_utils/perf_fixtures.ts';
import { parse } from './mod.ts';

const nextSyntheticArticle = cycleInputs(SYNTHETIC_ARTICLE_INPUTS);

summary(() => {
	bench('events() no position access: same-size plain (~8 KB)', () => {
		do_not_optimize(drainEventsNoPosition(SAME_SIZE_PLAIN_TEXT));
	}).gc('inner');

	bench('events() no position access: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainEventsNoPosition(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('events() no position access: same-size pathological (~8 KB)', () => {
		do_not_optimize(drainEventsNoPosition(SAME_SIZE_PATHOLOGICAL_TEXT));
	}).gc('inner');
});

summary(() => {
	bench('events() offsets only: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainEventsOffsetsOnly(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('events() offsets only: same-size pathological (~8 KB)', () => {
		do_not_optimize(drainEventsOffsetsOnly(SAME_SIZE_PATHOLOGICAL_TEXT));
	}).gc('inner');

	bench('events() all position reads: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainEventsWithPosition(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('events() all position reads: same-size pathological (~8 KB)', () => {
		do_not_optimize(drainEventsWithPosition(SAME_SIZE_PATHOLOGICAL_TEXT));
	}).gc('inner');

	bench('events() enter props reads: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainEnterProps(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('events() enter props reads: same-size pathological (~8 KB)', () => {
		do_not_optimize(drainEnterProps(SAME_SIZE_PATHOLOGICAL_TEXT));
	}).gc('inner');
});

summary(() => {
	bench('events() retained array only: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainRetainedEventCount(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('session.events() warm retained array: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainSessionRetainedEventCountWarm(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('events() retained array only: synthetic article (~35-45 KB)', () => {
		do_not_optimize(drainRetainedEventCount(nextSyntheticArticle()));
	}).gc('inner');

	bench('session.events() warm retained array: synthetic article (~35-45 KB)', () => {
		do_not_optimize(drainSessionRetainedEventCountWarm(nextSyntheticArticle()));
	}).gc('inner');
});

summary(() => {
	bench('parse(): same-size mixed (~8 KB)', () => {
		do_not_optimize(parse(SAME_SIZE_MIXED_TEXT).children.length);
	}).gc('inner');

	bench('parseWithDiagnostics(): same-size pathological (~8 KB)', () => {
		do_not_optimize(drainStatelessParseWithDiagnostics(SAME_SIZE_PATHOLOGICAL_TEXT));
	}).gc('inner');

	bench('session.events() cold: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainSessionEventsCold(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('session.events() warm: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainSessionEventsWarm(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('session.parse() cold: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainSessionParseCold(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('session.parse() warm: same-size mixed (~8 KB)', () => {
		do_not_optimize(drainSessionParseWarm(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('session.parseWithDiagnostics() cold: same-size pathological (~8 KB)', () => {
		do_not_optimize(drainSessionParseWithDiagnosticsCold(SAME_SIZE_PATHOLOGICAL_TEXT));
	}).gc('inner');

	bench('session.parseWithDiagnostics() warm: same-size pathological (~8 KB)', () => {
		do_not_optimize(drainSessionParseWithDiagnosticsWarm(SAME_SIZE_PATHOLOGICAL_TEXT));
	}).gc('inner');
	
	bench('parse(): synthetic article (~35-45 KB)', () => {
		do_not_optimize(parse(nextSyntheticArticle()).children.length);
	}).gc('inner');

	bench('session.events() warm: synthetic article (~35-45 KB)', () => {
		do_not_optimize(drainSessionEventsWarm(nextSyntheticArticle()));
	}).gc('inner');

	bench('session.parse() warm: synthetic article (~35-45 KB)', () => {
		do_not_optimize(drainSessionParseWarm(nextSyntheticArticle()));
	}).gc('inner');

	bench('session.parseWithDiagnostics() warm: synthetic article (~35-45 KB)', () => {
		do_not_optimize(drainSessionParseWithDiagnosticsWarm(nextSyntheticArticle()));
	}).gc('inner');
});

await run();