/**
 * Focused benchmarks for tree and event filtering helpers.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import type { WikitextEvent } from './events.ts';
import type { WikistRoot } from './ast.ts';

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import {
	cycleInputs,
	SAME_SIZE_MIXED_TEXT,
	SAME_SIZE_PATHOLOGICAL_TEXT,
	SYNTHETIC_ARTICLE_INPUTS,
} from './_test_utils/perf_fixtures.ts';
import {
	collectEvents,
	filter,
	filterEvents,
	filterLinks,
	filterReferences,
	filterTables,
	filterTemplates,
	locateDiagnostic,
	resolveDiagnosticAnchor,
	resolveTreePath,
	visit,
} from './filter.ts';
import { events, parse, parseWithDiagnostics } from './mod.ts';

type FilterBenchFixture = {
	label: string;
	tree: WikistRoot;
	events: WikitextEvent[];
};

type DiagnosticBenchFixture = {
	label: string;
	tree: WikistRoot;
	diagnostic_index: number;
	tree_path: readonly number[];
};

function createFilterBenchFixture(label: string, source: string): FilterBenchFixture {
	return {
		label,
		tree: parse(source),
		events: Array.from(events(source)),
	};
}

function createDiagnosticBenchFixture(
	label: string,
	source: string,
): DiagnosticBenchFixture {
	const result = parseWithDiagnostics(source);

	if (result.diagnostics.length === 0) {
		throw new Error(`Expected diagnostics for benchmark fixture: ${label}`);
	}

	return {
		label,
		tree: result.tree,
		diagnostic_index: 0,
		tree_path: result.diagnostics[0].anchor.path,
	};
}

function countVisitedNodes(tree: WikistRoot): number {
	let count = 0;

	visit(tree, () => {
		count++;
	});

	return count;
}

function countFilteredEvents(
	event_list: readonly WikitextEvent[],
	predicate: (event: WikitextEvent) => boolean,
): number {
	let count = 0;

	for (const _event of filterEvents(event_list, predicate)) {
		count++;
	}

	return count;
}

function sumCollectedGroupLengths(groups: readonly WikitextEvent[][]): number {
	let count = 0;

	for (const group of groups) {
		count += group.length;
	}

	return count;
}

function parseAndFilterCommonQueries(source: string): number {
	const tree = parse(source);

	return filterTemplates(tree).length
		+ filterLinks(tree).length
		+ filterTables(tree).length
		+ filterReferences(tree).length;
}

function eventWorkflowWikilinks(source: string): number {
	return sumCollectedGroupLengths(collectEvents(events(source), 'wikilink'));
}

const SAME_SIZE_MIXED_FIXTURE = createFilterBenchFixture(
	'same-size mixed (~8 KB)',
	SAME_SIZE_MIXED_TEXT,
);
const SAME_SIZE_PATHOLOGICAL_FIXTURE = createFilterBenchFixture(
	'same-size pathological (~8 KB)',
	SAME_SIZE_PATHOLOGICAL_TEXT,
);
const SYNTHETIC_ARTICLE_FIXTURES = SYNTHETIC_ARTICLE_INPUTS.map((source, index) =>
	createFilterBenchFixture(`synthetic article ${index + 1} (~35-45 KB)`, source)
);
const nextSyntheticArticle = cycleInputs(SYNTHETIC_ARTICLE_INPUTS);
const nextSyntheticArticleFixture = cycleInputs(SYNTHETIC_ARTICLE_FIXTURES);
const DIAGNOSTIC_FIXTURE = createDiagnosticBenchFixture(
	'unclosed table recovery',
	'{|\n| Cell\n',
);

summary(() => {
	bench(`visit(): ${SAME_SIZE_MIXED_FIXTURE.label}`, () => {
		do_not_optimize(countVisitedNodes(SAME_SIZE_MIXED_FIXTURE.tree));
	});

	bench(`filter(template): ${SAME_SIZE_MIXED_FIXTURE.label}`, () => {
		do_not_optimize(filter(SAME_SIZE_MIXED_FIXTURE.tree, 'template').length);
	}).gc('inner');

	bench(`filterLinks(): ${SAME_SIZE_MIXED_FIXTURE.label}`, () => {
		do_not_optimize(filterLinks(SAME_SIZE_MIXED_FIXTURE.tree).length);
	}).gc('inner');

	bench(`filterTables(): ${nextSyntheticArticleFixture().label}`, () => {
		do_not_optimize(filterTables(nextSyntheticArticleFixture().tree).length);
	}).gc('inner');

	bench(`filterReferences(): ${SAME_SIZE_PATHOLOGICAL_FIXTURE.label}`, () => {
		do_not_optimize(filterReferences(SAME_SIZE_PATHOLOGICAL_FIXTURE.tree).length);
	}).gc('inner');

	bench(`consumer workflow: parse -> filter common queries (${SAME_SIZE_MIXED_FIXTURE.label})`, () => {
		do_not_optimize(parseAndFilterCommonQueries(SAME_SIZE_MIXED_TEXT));
	}).gc('inner');

	bench('consumer workflow: parse -> filter common queries (synthetic article ~35-45 KB)', () => {
		do_not_optimize(parseAndFilterCommonQueries(nextSyntheticArticle()));
	}).gc('inner');
});

summary(() => {
	bench(`filterEvents(): enter events from ${SAME_SIZE_MIXED_FIXTURE.label}`, () => {
		do_not_optimize(countFilteredEvents(
			SAME_SIZE_MIXED_FIXTURE.events,
			(event) => event.kind === 'enter',
		));
	}).gc('inner');

	bench(`collectEvents(): wikilink slices from ${SAME_SIZE_MIXED_FIXTURE.label}`, () => {
		do_not_optimize(sumCollectedGroupLengths(
			collectEvents(SAME_SIZE_MIXED_FIXTURE.events, 'wikilink'),
		));
	}).gc('inner');

	bench('consumer workflow: events -> collectEvents(wikilink) (synthetic article ~35-45 KB)', () => {
		do_not_optimize(eventWorkflowWikilinks(nextSyntheticArticle()));
	}).gc('inner');
});

summary(() => {
	bench(`resolveTreePath(): ${DIAGNOSTIC_FIXTURE.label}`, () => {
		do_not_optimize(resolveTreePath(DIAGNOSTIC_FIXTURE.tree, DIAGNOSTIC_FIXTURE.tree_path));
	});

	bench(`resolveDiagnosticAnchor(): ${DIAGNOSTIC_FIXTURE.label}`, () => {
		const diagnostic = parseWithDiagnostics('{|\n| Cell\n').diagnostics[DIAGNOSTIC_FIXTURE.diagnostic_index];
		do_not_optimize(resolveDiagnosticAnchor(DIAGNOSTIC_FIXTURE.tree, diagnostic.anchor));
	}).gc('inner');

	bench(`locateDiagnostic(): ${DIAGNOSTIC_FIXTURE.label}`, () => {
		const result = parseWithDiagnostics('{|\n| Cell\n');
		do_not_optimize(locateDiagnostic(result.tree, result.diagnostics[DIAGNOSTIC_FIXTURE.diagnostic_index]));
	}).gc('inner');
});

await run();