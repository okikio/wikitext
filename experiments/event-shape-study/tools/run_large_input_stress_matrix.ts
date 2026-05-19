/**
 * Run the large-input one-shot stress collector across a scenario and size matrix.
 *
 * This keeps the branch's documented large-input workflow runnable without requiring
 * callers to hand-write one collector command per approach, scenario, and size.
 */

import { fromFileUrl, join, relative } from 'jsr:@std/path';

type JobResult = {
	approach: string;
	scenario: string;
	size_mib: number;
	profile: 'full' | 'streaming-only';
	output_path: string;
	status: 'ok' | 'failed';
	error_message?: string;
};

type MatrixRunSummary = {
	study: 'event-shape';
	generated_at: string;
	approaches: string[];
	scenarios: string[];
	sizes_mib: number[];
	repeats: number;
	gib_profile: 'full' | 'streaming-only';
	continue_on_error: boolean;
	jobs: JobResult[];
	commands: string[];
};

const STUDY_ROOT = fromFileUrl(new URL('../', import.meta.url));
const REPO_ROOT = fromFileUrl(new URL('../../../', import.meta.url));
const DEFAULT_SCENARIOS = [
	'plain-paragraphs',
	'mixed-article',
	'pathological-recovery',
	'table-heavy',
	'template-heavy',
	'inline-heavy',
	'uri-heavy',
	'unicode-heavy',
	'synthetic-article',
	'outline-heavy',
] as const;

function getFlag(name: string): string | undefined {
	return Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function hasFlag(name: string): boolean {
	return Deno.args.includes(`--${name}`);
}

function parseCsvFlag(name: string, fallback: readonly string[]): string[] {
	const raw = getFlag(name);
	if (raw === undefined) {
		return [...fallback];
	}

	const values = raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
	if (values.length === 0) {
		throw new Error(`expected --${name} to contain at least one comma-separated value`);
	}

	return values;
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

function parseSizeListFlag(name: string, fallback: readonly number[]): number[] {
	const raw = getFlag(name);
	if (raw === undefined) {
		return [...fallback];
	}

	return raw.split(',').map((value) => {
		const parsed = Number(value.trim());
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new Error(`expected --${name} to contain positive integers, got: ${raw}`);
		}

		return parsed;
	});
}

function parseProfileFlag(name: string, fallback: 'full' | 'streaming-only'): 'full' | 'streaming-only' {
	const raw = getFlag(name);
	if (raw === undefined) {
		return fallback;
	}

	if (raw !== 'full' && raw !== 'streaming-only') {
		throw new Error(`expected --${name} to be full or streaming-only, got: ${raw}`);
	}

	return raw;
}

function formatSizeLabel(size_mib: number): string {
	if (size_mib % 1024 === 0) {
		return `${size_mib / 1024}GiB`;
	}

	return `${size_mib}MiB`;
}

function buildOutputPath(
	approach: string,
	scenario: string,
	size_mib: number,
	profile: 'full' | 'streaming-only',
): string {
	const suffix = formatSizeLabel(size_mib);
	const file_name = size_mib >= 1024 && profile === 'full'
		? `stress-${scenario}-${suffix}-full.json`
		: `stress-${scenario}-${suffix}.json`;

	return join(STUDY_ROOT, approach, 'artifacts', file_name);
}

async function runCommand(args: string[]): Promise<void> {
	const command = new Deno.Command('mise', {
		args,
		cwd: REPO_ROOT,
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
}

const approaches = parseCsvFlag('approaches', []);
if (approaches.length === 0) {
	throw new Error('expected --approaches to contain at least one approach directory');
}

const scenarios = parseCsvFlag('scenarios', DEFAULT_SCENARIOS);
const sizes_mib = parseSizeListFlag('sizes-mib', [16, 1024]);
const repeats = parsePositiveIntFlag('repeats', 1);
const gib_profile = parseProfileFlag('gib-profile', 'streaming-only');
const continue_on_error = hasFlag('continue-on-error');

const commands: string[] = [];
const jobs: JobResult[] = [];

for (const approach of approaches) {
	for (const scenario of scenarios) {
		for (const size_mib of sizes_mib) {
			const profile = size_mib >= 1024 ? gib_profile : 'full';
			const output_path = buildOutputPath(approach, scenario, size_mib, profile);
			const v8_flags = size_mib >= 1024
				? '--v8-flags=--expose-gc,--max-old-space-size=8192'
				: '--v8-flags=--expose-gc';
			const args = [
				'x',
				'deno@latest',
				'--',
				'deno',
				'run',
				'--no-lock',
				'--allow-read',
				'--allow-write',
				'--allow-sys',
				v8_flags,
				'experiments/event-shape-study/tools/collect_large_input_stress_report.ts',
				`--approach-dir=${approach}`,
				`--variant=${approach.split('/').at(-1) ?? approach}`,
				`--scenario=${scenario}`,
				`--profile=${profile}`,
				`--size-mib=${size_mib}`,
				`--repeats=${repeats}`,
				`--out=${relative(REPO_ROOT, output_path)}`,
			];
			commands.push(`mise ${args.join(' ')}`);

			try {
				await runCommand(args);
				jobs.push({
					approach,
					scenario,
					size_mib,
					profile,
					output_path: relative(REPO_ROOT, output_path),
					status: 'ok',
				});
			} catch (error) {
				const error_message = error instanceof Error ? error.message : String(error);
				jobs.push({
					approach,
					scenario,
					size_mib,
					profile,
					output_path: relative(REPO_ROOT, output_path),
					status: 'failed',
					error_message,
				});

				if (!continue_on_error) {
					throw error;
				}
			}
		}
	}
}

const summary: MatrixRunSummary = {
	study: 'event-shape',
	generated_at: new Date().toISOString(),
	approaches,
	scenarios,
	sizes_mib,
	repeats,
	gib_profile,
	continue_on_error,
	jobs,
	commands,
};

console.log(JSON.stringify(summary, null, 2));