/**
 * Collect a large-input stress report from one approach-local code snapshot.
 *
 * This tool exists because the standard event-shape ledger focuses on smaller,
 * repeatable benchmark sizes that are cheap to rerun many times. Large-input
 * stress runs answer a different question: how the parser behaves when callers
 * hand it very large source strings, such as hundreds of MiB or about 1 GiB.
 *
 * The report intentionally stays separate from the main study acceptance ledger.
 * It is for scale behavior, survivability, and large-workload diagnostics rather
 * than the standard significance gate.
 */

import { dirname, fromFileUrl, join, relative } from 'jsr:@std/path';

type NumericSummary = {
	samples: number[];
	mean: number;
	median: number;
	minimum: number;
	maximum: number;
	stdev: number;
};

type StressSample = {
	index: number;
	elapsed_ms: number;
	heap_delta_bytes: number;
	checksum: number;
};

type StressCaseSummary = {
	name: string;
	samples: StressSample[];
	elapsed_ms: NumericSummary;
	heap_delta_bytes: NumericSummary;
};

type StressReport = {
	schema_version: 1;
	variant: string;
	approach_dir: string;
	generated_at: string;
	scenario: string;
	size_bytes: number;
	size_mib: number;
	repeats: number;
	environment: {
		deno_version: string;
		platform: string;
	};
	cases: StressCaseSummary[];
	notes: string[];
};

type ApproachModule = {
	events(input: string): Iterable<unknown>;
	parse(input: string): { children: unknown[] };
	parseWithDiagnostics(input: string): {
		tree: { children: unknown[] };
		diagnostics: unknown[];
	};
};

type StressCase = {
	name: string;
	run: (approach: ApproachModule, input: string) => number;
};

type ScenarioDefinition = {
	name: string;
	description: string;
	build: (size_bytes: number) => string;
};

type GcCapableGlobal = typeof globalThis & {
	gc?: () => void;
};

const STUDY_ROOT = fromFileUrl(new URL('../', import.meta.url));
const REPO_ROOT = fromFileUrl(new URL('../../../', import.meta.url));

const PLAIN_UNIT = [
	'Observational archives preserve calibration notes, weather corrections, and provenance language across long paragraphs of ordinary prose.',
	'This fixture keeps token density low so large-input runs represent the boring text-heavy documents that still cost a lot to scan and parse.',
	'',
].join(' ');

const MIXED_UNIT = [
	'== Heading ==',
	"A [[Main Page|home]] link with ''italic'' and '''bold'''.",
	'* Bullet item',
	'# Ordered item',
	'{|',
	'! Header !! Count',
	'|-',
	'| {{Item|name=Alpha}} || 42',
	'|}',
	'<ref name="cite-1">Example &amp; entity</ref>',
	'__TOC__',
	'',
].join('\n');

const PATHOLOGICAL_UNIT = [
	'[[[[{{{{<!--',
	'__BROKEN_',
	'<ref name="n">',
	"'''''",
	'&broken',
	'{|',
	'|-',
	'| [[Page|{{T|x}}]] || <span class="x">text',
	'',
].join('\n');

const SCENARIOS: readonly ScenarioDefinition[] = [
	{
		name: 'plain-paragraphs',
		description: 'Long ordinary prose with low token density.',
		build(size_bytes) {
			return repeatToMinimumSize(`${PLAIN_UNIT}\n\n`, size_bytes);
		},
	},
	{
		name: 'mixed-article',
		description: 'A repeated mix of headings, links, templates, tables, and refs.',
		build(size_bytes) {
			return repeatToMinimumSize(`${MIXED_UNIT}\n`, size_bytes);
		},
	},
	{
		name: 'pathological-recovery',
		description: 'Repeated malformed markup that stresses recovery paths.',
		build(size_bytes) {
			return repeatToMinimumSize(`${PATHOLOGICAL_UNIT}\n`, size_bytes);
		},
	},
] as const;

const STRESS_CASES: readonly StressCase[] = [
	{
		name: 'events() streamed count',
		run(approach, input) {
			let count = 0;
			for (const _event of approach.events(input)) {
				count++;
			}

			return count;
		},
	},
	{
		name: 'parse() child count',
		run(approach, input) {
			return approach.parse(input).children.length;
		},
	},
	{
		name: 'parseWithDiagnostics() tree+diagnostics count',
		run(approach, input) {
			const result = approach.parseWithDiagnostics(input);
			return result.tree.children.length + result.diagnostics.length;
		},
	},
] as const;

function getFlag(name: string): string | undefined {
	return Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function requireFlag(name: string): string {
	const value = getFlag(name);
	if (value === undefined || value.length === 0) {
		throw new Error(`missing required --${name}=... flag`);
	}

	return value;
}

function parsePositiveIntFlag(name: string, fallback: number): number {
	const raw = getFlag(name);
	if (raw === undefined) {
		return fallback;
	}

	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`expected --${name} to be a positive integer, got: ${raw}`);
	}

	return value;
}

function repeatToMinimumSize(unit: string, minimum_size: number): string {
	const repeat = Math.ceil(minimum_size / unit.length);
	return unit.repeat(repeat).slice(0, minimum_size);
}

function mean(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	if (sorted.length % 2 === 0) {
		return (sorted[middle - 1]! + sorted[middle]!) / 2;
	}

	return sorted[middle]!;
}

function stdev(values: readonly number[]): number {
	if (values.length === 1) {
		return 0;
	}

	const avg = mean(values);
	const variance = values.reduce((total, value) => {
		const delta = value - avg;
		return total + delta * delta;
	}, 0) / (values.length - 1);

	return Math.sqrt(variance);
}

function summarizeSamples(samples: readonly number[]): NumericSummary {
	return {
		samples: [...samples],
		mean: mean(samples),
		median: median(samples),
		minimum: Math.min(...samples),
		maximum: Math.max(...samples),
		stdev: stdev(samples),
	};
}

function forceGc(): void {
	const gc_capable_global = globalThis as GcCapableGlobal;

	for (let index = 0; index < 3; index++) {
		gc_capable_global.gc?.();
	}
}

function heapUsed(): number {
	forceGc();
	return Deno.memoryUsage().heapUsed;
}

async function loadApproachModule(approach_dir: string): Promise<ApproachModule> {
	const module_url = new URL(`../${approach_dir}/code/mod.ts`, import.meta.url);
	return await import(module_url.href) as ApproachModule;
}

function findScenario(name: string): ScenarioDefinition {
	const scenario = SCENARIOS.find((entry) => entry.name === name);
	if (scenario === undefined) {
		throw new Error(`unknown --scenario value: ${name}`);
	}

	return scenario;
}

function measureCase(case_def: StressCase, approach: ApproachModule, input: string, index: number): StressSample {
	const before = heapUsed();
	const start = performance.now();
	const checksum = case_def.run(approach, input);
	const elapsed_ms = performance.now() - start;
	const after = heapUsed();

	return {
		index,
		elapsed_ms,
		heap_delta_bytes: after - before,
		checksum,
	};
}

const approach_dir = requireFlag('approach-dir');
const variant = getFlag('variant') ?? approach_dir.split('/').at(-1)!;
const scenario_name = getFlag('scenario') ?? 'mixed-article';
const repeats = parsePositiveIntFlag('repeats', 3);
const size_mib = parsePositiveIntFlag('size-mib', 1024);
const out_raw = getFlag('out');
const out_path = out_raw === undefined ? undefined : join(REPO_ROOT, out_raw);

const scenario = findScenario(scenario_name);
const size_bytes = size_mib * 1024 * 1024;
const input = scenario.build(size_bytes);
const approach = await loadApproachModule(approach_dir);

const cases: StressCaseSummary[] = STRESS_CASES.map((case_def) => {
	const samples: StressSample[] = [];

	for (let index = 0; index < repeats; index++) {
		samples.push(measureCase(case_def, approach, input, index));
	}

	return {
		name: case_def.name,
		samples,
		elapsed_ms: summarizeSamples(samples.map((sample) => sample.elapsed_ms)),
		heap_delta_bytes: summarizeSamples(samples.map((sample) => sample.heap_delta_bytes)),
	};
});

const report: StressReport = {
	schema_version: 1,
	variant,
	approach_dir,
	generated_at: new Date().toISOString(),
	scenario: scenario.name,
	size_bytes,
	size_mib,
	repeats,
	environment: {
		deno_version: `deno ${Deno.version.deno} / v8 ${Deno.version.v8} / typescript ${Deno.version.typescript}`,
		platform: `${Deno.build.arch}-${Deno.build.os}`,
	},
	cases,
	notes: [
		'Large-input stress runs are intentionally separate from the main acceptance ledger.',
		'String sizes are generated on demand so the study can run MiB-scale and GiB-scale scenarios without checking giant fixtures into the repo.',
		`Scenario description: ${scenario.description}`,
	],
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;

if (out_path === undefined) {
	console.log(serialized);
	Deno.exit(0);
}

await Deno.mkdir(dirname(out_path), { recursive: true });
await Deno.writeTextFile(out_path, serialized);
console.log(`wrote ${relative(REPO_ROOT, out_path)}`);