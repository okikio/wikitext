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

type TextSource = {
	length: number;
	charCodeAt(index: number): number;
	slice(start: number, end: number): string;
	iterSlices?(start: number, end: number): Iterable<string>;
};

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
	status: 'ok' | 'failed';
	elapsed_ms: number;
	heap_delta_bytes: number;
	checksum: number | null;
	error_message?: string;
};

type StressCaseSummary = {
	name: string;
	samples: StressSample[];
	ok_sample_count: number;
	failed_sample_count: number;
	elapsed_ms: NumericSummary | null;
	heap_delta_bytes: NumericSummary | null;
};

type StressReport = {
	schema_version: 2;
	variant: string;
	approach_dir: string;
	generated_at: string;
	profile: 'full' | 'streaming-only';
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
	events(input: TextSource): Iterable<unknown>;
	parse(input: TextSource): { children: unknown[] };
	parseWithDiagnostics(input: TextSource): {
		tree: { children: unknown[] };
		diagnostics: unknown[];
	};
};

type StressCase = {
	name: string;
	run: (approach: ApproachModule, input: TextSource) => number;
};

type ScenarioDefinition = {
	name: string;
	description: string;
	build: (size_bytes: number) => TextSource;
};

type GcCapableGlobal = typeof globalThis & {
	gc?: () => void;
};

const STUDY_ROOT = fromFileUrl(new URL('../', import.meta.url));
const REPO_ROOT = fromFileUrl(new URL('../../../', import.meta.url));

function resolveOutputPath(raw_path: string): string {
	return raw_path.startsWith('/') ? raw_path : join(REPO_ROOT, raw_path);
}

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

const TABLE_HEAVY_UNIT = [
	'{| class="wikitable sortable"',
	'! Planet !! Radius !! Mass !! Notes',
	'|-',
	'| Mercury || 2,439.7 km || 3.30e23 kg || [[Inner planet]]',
	'|-',
	'| Venus || 6,051.8 km || 4.87e24 kg || {{Val|4.87|e=24|u=kg}}',
	'|-',
	'| Earth || 6,371.0 km || 5.97e24 kg || <ref name="earth">Reference</ref>',
	'|-',
	"| Mars || 3,389.5 km || 6.42e23 kg || ''Surveyed''",
	'|}',
	'',
].join('\n');

const TEMPLATE_HEAVY_UNIT = [
	'{{Infobox settlement',
	'| name = Example City',
	'| image = {{Map frame|lat=51.5|lon=-0.1|zoom=12}}',
	'| region = {{Plainlist|* [[Region A]]|* [[Region B]]}}',
	'| population = {{Formatnum:1234567}}',
	'| leader = {{Person|name=Alex Example|title=Mayor}}',
	'}}',
	'{{Navbox|title=Transit|list1={{Flatlist|* Line A * Line B * Line C}}}}',
	'{{Citation needed|date={{Start date|2024|05|17}}}}',
	'',
].join('\n');

const INLINE_HEAVY_UNIT = [
	'== Inline ==',
	"A [[Main Page|home]] link with ''italic'', '''bold''', and '''''both'''''.",
	'<ref name="cite-1" group="note">Example &amp; entity with {{Citation|title=Doc}}</ref>',
	'<span class="lead">inline tag</span> and <br/> break and <nowiki>[[literal]] {{literal}}</nowiki>.',
	'[https://example.com Example] {{Card|name=value|body=<span>ok</span>}} __TOC__ ~~~~',
	'',
].join('\n');

const URI_HEAVY_UNIT = [
	'Visit https://example.com/path(test)?q=alpha,beta and then https://example.org/docs/path(testing).',
	'Open file:///Users/example/report.txt or contact mailto:editor@example.org next.',
	'Catalog urn:isbn:0451450523 and call tel:+12025550123 before loading data:text/plain,hello.',
	'Fetch magnet:?xt=urn:btih:abcdef, launch foo+bar://example.service/path, and compare [https://example.com Example].',
	'Reminder: check the corpus matrix, note:abc, chapter:one, longcustomscheme:alpha, abchttps://example.com, Visit https://',
	'',
].join('\n');

const UNICODE_HEAVY_UNIT = [
	'== Unicode ==',
	'Cafe\u0301 nai\u0308ve Z\u0323a\u0301lgo alpha\u200Bbeta\u200Cgamma\u200Ddelta\u2060omega\uFEFFend',
	'раураl Αlpha Сode οrn 👩🏽‍🚀👨‍👩‍👧‍👦🏳️‍🌈☕️',
	'日本語かな交じり文漢字テスト مرحبابالعالمكيفالحال 𓀀𓁐𓂀𓃀𓆣',
	'（＾ω＾）人（＾∀＾）ノ abc\u200Fمرحبا\u200Exyz [[Main Page|home]] {{Card|name=Unicode}}',
	'',
].join('\n');

const SYNTHETIC_ARTICLE_UNIT = [
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
].join('\n');

const OUTLINE_HEAVY_UNIT = [
	'== Astronomy ==',
	'* Observation',
	'** Calibration',
	'*** Drift notes',
	'# Sequence one',
	'## Nested ordinal note',
	'; Instrument',
	': Mirror-backed camera with long-form plain prose and careful terminology.',
	'; Exposure',
	': Repeated block structure should stay outline-heavy even when prose fills each item.',
	'=== Archive ===',
	'* Preservation log',
	'* Range tracking notes',
	'; Recovery policy',
	': Keep structure stable and inline markup intentionally light.',
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
	{
		name: 'table-heavy',
		description: 'Dense table markup with repeated rows, cells, refs, and attributes.',
		build(size_bytes) {
			return repeatToMinimumSize(`${TABLE_HEAVY_UNIT}\n`, size_bytes);
		},
	},
	{
		name: 'template-heavy',
		description: 'Repeated nested templates and parser-like value formatting.',
		build(size_bytes) {
			return repeatToMinimumSize(`${TEMPLATE_HEAVY_UNIT}\n`, size_bytes);
		},
	},
	{
		name: 'inline-heavy',
		description: 'Repeated inline markup with links, emphasis, refs, tags, and nowiki spans.',
		build(size_bytes) {
			return repeatToMinimumSize(`${INLINE_HEAVY_UNIT}\n`, size_bytes);
		},
	},
	{
		name: 'uri-heavy',
		description: 'Dense URI acceptance and rejection cases embedded in surrounding prose.',
		build(size_bytes) {
			return repeatToMinimumSize(`${URI_HEAVY_UNIT}\n`, size_bytes);
		},
	},
	{
		name: 'unicode-heavy',
		description: 'Unicode-heavy document text with combining marks, controls, emoji, RTL, and astral symbols.',
		build(size_bytes) {
			return repeatToMinimumSize(`${UNICODE_HEAVY_UNIT}\n`, size_bytes);
		},
	},
	{
		name: 'synthetic-article',
		description: 'Larger article-shaped structure with repeated transitions across headings, prose, lists, tables, refs, tags, and templates.',
		build(size_bytes) {
			return repeatToMinimumSize(`${SYNTHETIC_ARTICLE_UNIT}\n`, size_bytes);
		},
	},
	{
		name: 'outline-heavy',
		description: 'Heading, list, and definition-list structure with intentionally light inline markup.',
		build(size_bytes) {
			return repeatToMinimumSize(`${OUTLINE_HEAVY_UNIT}\n`, size_bytes);
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

function findStressCases(profile: 'full' | 'streaming-only'): readonly StressCase[] {
	switch (profile) {
		case 'full':
			return STRESS_CASES;
		case 'streaming-only':
			return [STRESS_CASES[0]!];
	}
}

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

class RepeatedTextSource implements TextSource {
	readonly length: number;

	constructor(
		private readonly unit: string,
		minimum_size: number,
	) {
		if (unit.length === 0) {
			throw new Error('RepeatedTextSource requires a non-empty unit string');
		}

		this.length = minimum_size;
	}

	charCodeAt(index: number): number {
		if (index < 0 || index >= this.length) {
			return Number.NaN;
		}

		return this.unit.charCodeAt(index % this.unit.length);
	}

	slice(start: number, end: number): string {
		return Array.from(this.iterSlices(start, end)).join('');
	}

	*iterSlices(start: number, end: number): Iterable<string> {
		const safe_start = Math.max(0, Math.min(start, this.length));
		const safe_end = Math.max(safe_start, Math.min(end, this.length));
		let cursor = safe_start;

		while (cursor < safe_end) {
			const unit_offset = cursor % this.unit.length;
			const take = Math.min(safe_end - cursor, this.unit.length - unit_offset);
			yield this.unit.slice(unit_offset, unit_offset + take);
			cursor += take;
		}
	}
}

function repeatToMinimumSize(unit: string, minimum_size: number): TextSource {
	if (unit.length === 0) {
		throw new Error('repeatToMinimumSize requires a non-empty unit string');
	}

	return new RepeatedTextSource(unit, minimum_size);
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

function measureCase(case_def: StressCase, approach: ApproachModule, input: TextSource, index: number): StressSample {
	const before = heapUsed();
	const start = performance.now();

	try {
		const checksum = case_def.run(approach, input);
		const elapsed_ms = performance.now() - start;
		const after = heapUsed();

		return {
			index,
			status: 'ok',
			elapsed_ms,
			heap_delta_bytes: after - before,
			checksum,
		};
	} catch (error) {
		const elapsed_ms = performance.now() - start;
		const after = heapUsed();

		return {
			index,
			status: 'failed',
			elapsed_ms,
			heap_delta_bytes: after - before,
			checksum: null,
			error_message: error instanceof Error
				? `${error.name}: ${error.message}`
				: String(error),
		};
	}
}

const approach_dir = requireFlag('approach-dir');
const variant = getFlag('variant') ?? approach_dir.split('/').at(-1)!;
const scenario_name = getFlag('scenario') ?? 'mixed-article';
const profile = (getFlag('profile') ?? 'full') as 'full' | 'streaming-only';
const repeats = parsePositiveIntFlag('repeats', 3);
const size_mib = parsePositiveIntFlag('size-mib', 1024);
const out_raw = getFlag('out');
const out_path = out_raw === undefined ? undefined : resolveOutputPath(out_raw);

const scenario = findScenario(scenario_name);
const stress_cases = findStressCases(profile);
const size_bytes = size_mib * 1024 * 1024;
const input = scenario.build(size_bytes);
const approach = await loadApproachModule(approach_dir);

const cases: StressCaseSummary[] = stress_cases.map((case_def) => {
	const samples: StressSample[] = [];
	const ok_samples: StressSample[] = [];

	for (let index = 0; index < repeats; index++) {
		const sample = measureCase(case_def, approach, input, index);
		samples.push(sample);
		if (sample.status === 'ok') {
			ok_samples.push(sample);
		}
	}

	return {
		name: case_def.name,
		samples,
		ok_sample_count: ok_samples.length,
		failed_sample_count: samples.length - ok_samples.length,
		elapsed_ms: ok_samples.length > 0
			? summarizeSamples(ok_samples.map((sample) => sample.elapsed_ms))
			: null,
		heap_delta_bytes: ok_samples.length > 0
			? summarizeSamples(ok_samples.map((sample) => sample.heap_delta_bytes))
			: null,
	};
});

const report: StressReport = {
	schema_version: 2,
	variant,
	approach_dir,
	generated_at: new Date().toISOString(),
	profile,
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
		profile === 'streaming-only'
			? 'This artifact uses the streaming-only stress profile to keep 1 GiB runs focused on event-path survivability instead of full tree materialization.'
			: 'This artifact uses the full stress profile, including tree materialization and diagnostics.',
		cases.some((case_summary) => case_summary.failed_sample_count > 0)
			? 'One or more stress cases failed and were recorded in-place so the artifact still captures the scenario limit.'
			: 'All requested stress cases completed successfully.',
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