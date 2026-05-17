/**
 * Retained-memory measurements for event-shape experiments.
 *
 * This script stays outside mitata so heap snapshots are not mixed into hot
 * benchmark callbacks. It keeps the measurement cases aligned with
 * event_shape_bench.ts so timing and retained-memory comparisons tell the same
 * story.
 */

import {
	drainSessionRetainedEventCountWarm,
	SAME_SIZE_MIXED_TEXT,
	sumEnterPropKeyCounts,
	sumEventPositionOffsets,
	SYNTHETIC_ARTICLE_INPUTS,
} from './_test_utils/perf_fixtures.ts';
import type { WikitextEvent } from './events.ts';
import { createSession, events, parse, parseWithDiagnostics } from './mod.ts';

type MeasurementCase = {
	name: string;
	run: (input: string) => unknown;
	consume: (value: unknown) => number;
};

type MeasurementSummary = {
	name: string;
	samples: number[];
	median: number;
	minimum: number;
	maximum: number;
};

type InputSummary = {
	name: string;
	cases: MeasurementSummary[];
};

type OutputFormat = 'text' | 'json';

function asEventList(value: unknown): WikitextEvent[] {
	return value as WikitextEvent[];
}

const DEFAULT_REPEATS = 5;
const INPUTS = [
	{
		name: 'same-size mixed (~8 KB)',
		value: SAME_SIZE_MIXED_TEXT,
	},
	{
		name: 'synthetic article (~35-45 KB)',
		value: SYNTHETIC_ARTICLE_INPUTS[0],
	},
] as const;

const MEASUREMENT_CASES: readonly MeasurementCase[] = [
	{
		name: 'events retained, no position reads',
		run(input) {
			return Array.from(events(input));
		},
		consume(value) {
			return (value as unknown[]).length;
		},
	},
	{
		name: 'events retained, then read every position',
		run(input) {
			const retained = Array.from(events(input));
			return retained;
		},
		consume(value) {
			const retained = asEventList(value);
			return retained.length + sumEventPositionOffsets(retained);
		},
	},
	{
		name: 'events retained, then read enter props',
		run(input) {
			const retained = Array.from(events(input));
			return retained;
		},
		consume(value) {
			const retained = asEventList(value);
			return retained.length + sumEnterPropKeyCounts(retained);
		},
	},
	{
		name: 'session warm event cache retained',
		run(input) {
			const session = createSession(input);
			Array.from(session.events());
			return session;
		},
		consume(value) {
			return Array.from((value as ReturnType<typeof createSession>).events()).length;
		},
	},
	{
		name: 'parse() result retained',
		run(input) {
			return parse(input);
		},
		consume(value) {
			return (value as ReturnType<typeof parse>).children.length;
		},
	},
	{
		name: 'parseWithDiagnostics() result retained',
		run(input) {
			return parseWithDiagnostics(input);
		},
		consume(value) {
			const result = value as ReturnType<typeof parseWithDiagnostics>;
			return result.tree.children.length + result.diagnostics.length;
		},
	},
] as const;

function forceGc(): void {
	for (let index = 0; index < 3; index++) {
		globalThis.gc?.();
	}
}

function heapUsed(): number {
	forceGc();
	return Deno.memoryUsage().heapUsed;
}

function measureRetainedHeap(case_def: MeasurementCase, input: string): number {
	forceGc();
	const before = heapUsed();

	const retained = case_def.run(input);
	const checksum = case_def.consume(retained);

	if (checksum < 0) {
		throw new Error('unexpected negative checksum');
	}

	const after = heapUsed();
	return after - before;
}

function parseRepeats(): number {
	const repeats_arg = Deno.args.find((arg) => arg.startsWith('--repeats='));

	if (repeats_arg === undefined) {
		return DEFAULT_REPEATS;
	}

	const value = Number(repeats_arg.slice('--repeats='.length));
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`expected a positive integer for --repeats, got: ${repeats_arg}`);
	}

	return value;
}

function parseFormat(): OutputFormat {
	const format_arg = Deno.args.find((arg) => arg.startsWith('--format='));

	if (format_arg === undefined) {
		return 'text';
	}

	const value = format_arg.slice('--format='.length);
	if (value === 'json' || value === 'text') {
		return value;
	}

	throw new Error(`expected --format=text or --format=json, got: ${format_arg}`);
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	if (sorted.length % 2 === 0) {
		return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
	}

	return sorted[middle]!;
}

function summarize(case_def: MeasurementCase, input: string, repeats: number): MeasurementSummary {
	const samples: number[] = [];

	for (let index = 0; index < repeats; index++) {
		samples.push(measureRetainedHeap(case_def, input));
	}

	return {
		name: case_def.name,
		samples,
		median: median(samples),
		minimum: Math.min(...samples),
		maximum: Math.max(...samples),
	};
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
	}

	if (bytes >= 1024) {
		return `${(bytes / 1024).toFixed(2)} KiB`;
	}

	return `${bytes} B`;
}

const repeats = parseRepeats();
const format = parseFormat();
const summaries: InputSummary[] = [];

for (const input of INPUTS) {
	const input_summary: InputSummary = {
		name: input.name,
		cases: [],
	};

	for (const case_def of MEASUREMENT_CASES) {
		const summary = summarize(case_def, input.value, repeats);
		input_summary.cases.push(summary);
	}

	summaries.push(input_summary);
}

if (format === 'json') {
	console.log(JSON.stringify({
		generated_at: new Date().toISOString(),
		repeats,
		unit: 'bytes',
		inputs: summaries.map((input) => ({
			name: input.name,
			cases: input.cases.map((summary) => ({
				name: summary.name,
				samples_bytes: summary.samples,
				median_bytes: summary.median,
				minimum_bytes: summary.minimum,
				maximum_bytes: summary.maximum,
			})),
		})),
	}, null, 2));
	Deno.exit(0);
}

for (const input of summaries) {
	console.log(`\n# ${input.name}`);
	console.log(`repeats=${repeats}`);

	for (const summary of input.cases) {
		console.log(
			`${summary.name}: median=${formatBytes(summary.median)}, min=${formatBytes(summary.minimum)}, max=${formatBytes(summary.maximum)}, samples=[${summary.samples.join(', ')}]`,
		);
	}
}