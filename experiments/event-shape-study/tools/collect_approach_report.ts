/**
 * Collect one event-shape report from an approach-local code snapshot.
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

type TimingRun = {
	index: number;
	benchmarks: Record<string, number>;
};

type MemoryRun = {
	index: number;
	inputs: Record<string, Record<string, number>>;
};

type EnvironmentMetadata = {
	uname: string;
	deno_version: string;
	lscpu_summary: Record<string, string>;
	git_worktree_clean: boolean;
};

type DesignMetadata = {
	timing_command: string;
	memory_command: string;
	approach_dir: string;
	code_dir: string;
	independent_process_per_run: true;
	raw_samples_preserved: true;
	bootstrap_ready: true;
	notes: string[];
};

type EventShapeReport = {
	schema_version: 1;
	variant: string;
	branch: string;
	commit: string;
	generated_at: string;
	runs: number;
	memory_repeats: number;
	timing_unit: 'microseconds_per_iter';
	memory_unit: 'bytes';
	environment: EnvironmentMetadata;
	design: DesignMetadata;
	timing: {
		per_run: TimingRun[];
		summary: Record<string, NumericSummary>;
	};
	memory: {
		per_run: MemoryRun[];
		summary: Record<string, Record<string, NumericSummary>>;
	};
};

const STUDY_ROOT = fromFileUrl(new URL('../', import.meta.url));
const REPO_ROOT = fromFileUrl(new URL('../../../', import.meta.url));

function resolveOutputPath(raw_path: string): string {
	return raw_path.startsWith('/') ? raw_path : join(REPO_ROOT, raw_path);
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

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function toMicroseconds(value: number, unit: string): number {
	switch (unit) {
		case 'ns':
			return value / 1000;
		case 'µs':
			return value;
		case 'ms':
			return value * 1000;
		case 's':
			return value * 1000 * 1000;
		default:
			throw new Error(`unsupported timing unit: ${unit}`);
	}
}

function parseTimingOutput(output: string): Record<string, number> {
	const benchmarks: Record<string, number> = {};
	const pattern = /^(?<name>.+?)\s{2,}(?<avg>[0-9]+(?:\.[0-9]+)?)\s*(?<unit>ns|µs|ms|s)\/iter\b/u;

	for (const line of stripAnsi(output).split('\n')) {
		const match = pattern.exec(line.trimEnd());
		if (match?.groups === undefined) {
			continue;
		}

		benchmarks[match.groups.name] = toMicroseconds(
			Number(match.groups.avg),
			match.groups.unit,
		);
	}

	if (Object.keys(benchmarks).length === 0) {
		throw new Error('failed to parse any timing benchmarks from local event_shape_bench.ts output');
	}

	return benchmarks;
}

function parseMemoryOutput(output: string): Record<string, Record<string, number>> {
	const parsed = JSON.parse(output) as {
		inputs: Array<{
			name: string;
			cases: Array<{
				name: string;
				median_bytes: number;
			}>;
		}>;
	};

	const inputs: Record<string, Record<string, number>> = {};

	for (const input of parsed.inputs) {
		inputs[input.name] = {};

		for (const case_result of input.cases) {
			inputs[input.name]![case_result.name] = case_result.median_bytes;
		}
	}

	return inputs;
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

async function runCommand(cwd: string, args: string[]): Promise<string> {
	const command = new Deno.Command('mise', {
		args,
		cwd,
		stdout: 'piped',
		stderr: 'piped',
		env: {
			NODE_DISABLE_COLORS: '1',
		},
	});
	const output = await command.output();
	const stdout = new TextDecoder().decode(output.stdout);
	const stderr = new TextDecoder().decode(output.stderr);

	if (!output.success) {
		throw new Error(`command failed: mise ${args.join(' ')}\n${stdout}\n${stderr}`);
	}

	return stdout;
}

async function readGitValue(args: string[]): Promise<string> {
	return stripAnsi(await runCommand(REPO_ROOT, args)).trim();
}

function summarizeLscpu(output: string): Record<string, string> {
	const interesting_keys = new Set([
		'Architecture',
		'CPU(s)',
		'Core(s) per socket',
		'Thread(s) per core',
		'Socket(s)',
		'Vendor ID',
		'Model name',
		'CPU max MHz',
		'CPU(s) scaling MHz',
	]);
	const summary: Record<string, string> = {};

	for (const line of stripAnsi(output).split('\n')) {
		const separator = line.indexOf(':');
		if (separator === -1) {
			continue;
		}

		const key = line.slice(0, separator).trim();
		if (!interesting_keys.has(key)) {
			continue;
		}

		summary[key] = line.slice(separator + 1).trim();
	}

	return summary;
}

function summarizeTimingRuns(runs: readonly TimingRun[]): Record<string, NumericSummary> {
	const by_name = new Map<string, number[]>();

	for (const run of runs) {
		for (const [name, value] of Object.entries(run.benchmarks)) {
			const samples = by_name.get(name) ?? [];
			samples.push(value);
			by_name.set(name, samples);
		}
	}

	return Object.fromEntries(
		Array.from(by_name.entries()).map(([name, samples]) => [name, summarizeSamples(samples)]),
	);
}

function summarizeMemoryRuns(runs: readonly MemoryRun[]): Record<string, Record<string, NumericSummary>> {
	const by_input = new Map<string, Map<string, number[]>>();

	for (const run of runs) {
		for (const [input_name, cases] of Object.entries(run.inputs)) {
			const input_map = by_input.get(input_name) ?? new Map<string, number[]>();

			for (const [case_name, value] of Object.entries(cases)) {
				const samples = input_map.get(case_name) ?? [];
				samples.push(value);
				input_map.set(case_name, samples);
			}

			by_input.set(input_name, input_map);
		}
	}

	return Object.fromEntries(
		Array.from(by_input.entries()).map(([input_name, case_map]) => [
			input_name,
			Object.fromEntries(
				Array.from(case_map.entries()).map(([case_name, samples]) => [case_name, summarizeSamples(samples)]),
			),
		]),
	);
}

const approach_dir_flag = requireFlag('approach-dir');
const approach_dir = join(STUDY_ROOT, approach_dir_flag);
const code_dir = join(approach_dir, 'code');
const runs = parsePositiveIntFlag('runs', 10);
const memory_repeats = parsePositiveIntFlag('memory-repeats', 5);
const variant = getFlag('variant') ?? approach_dir_flag.split('/').at(-1)!;
const out_raw = getFlag('out');
const out_path = out_raw === undefined ? undefined : resolveOutputPath(out_raw);

const timing_runs: TimingRun[] = [];
const memory_runs: MemoryRun[] = [];

const timing_command = 'mise x deno@latest -- deno bench --no-lock --allow-sys --allow-env=NODE_DISABLE_COLORS --v8-flags=--expose-gc event_shape_bench.ts';
const memory_command = `mise x deno@latest -- deno run --no-lock --allow-sys --v8-flags=--expose-gc event_shape_memory.ts --repeats=${memory_repeats} --format=json`;

const environment: EnvironmentMetadata = {
	uname: await readGitValue(['x', 'deno@latest', '--', 'uname', '-srvmo']),
	deno_version: await readGitValue(['x', 'deno@latest', '--', 'deno', '--version']),
	lscpu_summary: summarizeLscpu(await runCommand(REPO_ROOT, ['x', 'deno@latest', '--', 'lscpu'])),
	git_worktree_clean: (await readGitValue(['x', 'deno@latest', '--', 'git', 'status', '--porcelain'])).length === 0,
};

const design: DesignMetadata = {
	timing_command,
	memory_command,
	approach_dir: relative(REPO_ROOT, approach_dir),
	code_dir: relative(REPO_ROOT, code_dir),
	independent_process_per_run: true,
	raw_samples_preserved: true,
	bootstrap_ready: true,
	notes: [
		'Each timing run executes the approach-local event_shape_bench.ts in a fresh process.',
		'Each memory run executes the approach-local event_shape_memory.ts in a fresh process with explicit repeats.',
		'All code under test lives inside the approach-local code snapshot to reduce cross-approach variation from root-directory edits.',
	],
};

for (let index = 0; index < runs; index++) {
	const timing_output = await runCommand(code_dir, [
		'x',
		'deno@latest',
		'--',
		'deno',
		'bench',
		'--no-lock',
		'--allow-sys',
		'--allow-env=NODE_DISABLE_COLORS',
		'--v8-flags=--expose-gc',
		'event_shape_bench.ts',
	]);
	timing_runs.push({
		index,
		benchmarks: parseTimingOutput(timing_output),
	});

	const memory_output = await runCommand(code_dir, [
		'x',
		'deno@latest',
		'--',
		'deno',
		'run',
		'--no-lock',
		'--allow-sys',
		'--v8-flags=--expose-gc',
		'event_shape_memory.ts',
		`--repeats=${memory_repeats}`,
		'--format=json',
	]);
	memory_runs.push({
		index,
		inputs: parseMemoryOutput(memory_output),
	});
}

const report: EventShapeReport = {
	schema_version: 1,
	variant,
	branch: await readGitValue(['x', 'deno@latest', '--', 'git', 'branch', '--show-current']),
	commit: await readGitValue(['x', 'deno@latest', '--', 'git', 'rev-parse', 'HEAD']),
	generated_at: new Date().toISOString(),
	runs,
	memory_repeats,
	timing_unit: 'microseconds_per_iter',
	memory_unit: 'bytes',
	environment,
	design,
	timing: {
		per_run: timing_runs,
		summary: summarizeTimingRuns(timing_runs),
	},
	memory: {
		per_run: memory_runs,
		summary: summarizeMemoryRuns(memory_runs),
	},
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;

if (out_path === undefined) {
	console.log(serialized);
	Deno.exit(0);
}

await Deno.mkdir(dirname(out_path), { recursive: true });
await Deno.writeTextFile(out_path, serialized);
console.log(`wrote ${relative(REPO_ROOT, out_path)}`);
