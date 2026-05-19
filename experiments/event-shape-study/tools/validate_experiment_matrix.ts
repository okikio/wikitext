/**
 * Validate that the documented event-shape study surface exists on this branch.
 *
 * This is a structural preflight. It does not rerun benchmarks. It checks that the
 * core docs, study tools, approach-local snapshots, and baseline checked-in smoke
 * artifacts are present before new collection starts.
 */

import { fromFileUrl, join, relative } from 'jsr:@std/path';

type CheckResult = {
	path: string;
	status: 'ok' | 'missing';
	kind: 'doc' | 'tool' | 'approach-file' | 'artifact';
};

const STUDY_ROOT = fromFileUrl(new URL('../', import.meta.url));
const REPO_ROOT = fromFileUrl(new URL('../../../', import.meta.url));
const APPROACHES = [
	'current-baseline',
	'shared-props',
	'lazy-position',
	'lazy-position-shared-props',
	'planned-flat-eager-event-shape',
] as const;
const DOC_PATHS = [
	'README.md',
	'methods.md',
	'protocol.md',
	'results.md',
	'scenario-roadmap.md',
] as const;
const TOOL_PATHS = [
	'tools/collect_approach_report.ts',
	'tools/collect_large_input_stress_report.ts',
	'tools/compare_reports.ts',
	'tools/record_approach_artifacts.ts',
	'tools/run_cross_candidate_schedule.ts',
	'tools/run_large_input_stress_matrix.ts',
	'tools/validate_experiment_matrix.ts',
] as const;

async function pathExists(path: string): Promise<boolean> {
	try {
		await Deno.stat(path);
		return true;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return false;
		}

		throw error;
	}
}

async function checkPath(path: string, kind: CheckResult['kind']): Promise<CheckResult> {
	return {
		path: relative(REPO_ROOT, path),
		status: await pathExists(path) ? 'ok' : 'missing',
		kind,
	};
}

const results: CheckResult[] = [];

for (const doc_path of DOC_PATHS) {
	results.push(await checkPath(join(STUDY_ROOT, doc_path), 'doc'));
}

for (const tool_path of TOOL_PATHS) {
	results.push(await checkPath(join(STUDY_ROOT, tool_path), 'tool'));
}

for (const approach of APPROACHES) {
	results.push(await checkPath(join(STUDY_ROOT, approach, 'code', 'mod.ts'), 'approach-file'));
	results.push(await checkPath(join(STUDY_ROOT, approach, 'artifacts', 'report.json'), 'artifact'));
	results.push(await checkPath(join(STUDY_ROOT, approach, 'artifacts', 'stress-mixed-16MiB.json'), 'artifact'));
}

const missing = results.filter((entry) => entry.status === 'missing');

for (const group of ['doc', 'tool', 'approach-file', 'artifact'] as const) {
	const group_entries = results.filter((entry) => entry.kind === group);
	console.log(`${group}:`);
	for (const entry of group_entries) {
		console.log(`  [${entry.status}] ${entry.path}`);
	}
	console.log('');
}

if (missing.length > 0) {
	console.error(`missing ${missing.length} required study paths`);
	Deno.exit(1);
}

console.log(`validated ${results.length} study paths`);