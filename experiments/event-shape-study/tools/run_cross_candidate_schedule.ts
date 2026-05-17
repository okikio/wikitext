/**
 * Run a deterministic round-robin collection schedule across approach-local code snapshots.
 */

import { fromFileUrl, join, relative } from 'jsr:@std/path';

type ScheduleEntry = {
	round: number;
	order: number;
	approach: string;
	report_path: string;
	comparison_json?: string;
	comparison_text?: string;
};

type ScheduleOutput = {
	study: 'event-shape';
	baseline: string;
	approaches: string[];
	rounds: number;
	runs_per_report: number;
	memory_repeats: number;
	minimum_improvement: number;
	maximum_regression: number;
	bootstrap_iterations: number;
	alpha: number;
	entries: ScheduleEntry[];
	commands: string[];
};

const STUDY_ROOT = fromFileUrl(new URL('../', import.meta.url));
const REPO_ROOT = fromFileUrl(new URL('../../../', import.meta.url));

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

function parseFloatFlag(name: string, fallback: number): number {
	const raw = getFlag(name);
	if (raw === undefined) {
		return fallback;
	}

	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`expected --${name} to be numeric, got: ${raw}`);
	}

	return value;
}

function parseApproaches(): string[] {
	const raw = requireFlag('approaches');
	return raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
}

function rotate<T>(values: readonly T[], offset: number): T[] {
	const pivot = offset % values.length;
	return [...values.slice(pivot), ...values.slice(0, pivot)];
}

async function runCommand(args: string[], cwd = REPO_ROOT): Promise<string> {
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

const baseline = requireFlag('baseline');
const approaches = parseApproaches();
const rounds = parsePositiveIntFlag('rounds', 1);
const runs = parsePositiveIntFlag('runs', 10);
const memory_repeats = parsePositiveIntFlag('memory-repeats', 5);
const minimum_improvement = parseFloatFlag('min-improvement', 0.05);
const maximum_regression = parseFloatFlag('max-regression', 0.03);
const bootstrap_iterations = parsePositiveIntFlag('bootstrap', 5000);
const alpha = parseFloatFlag('alpha', 0.05);
const run_label = requireFlag('run-label');
const run_dir = join(STUDY_ROOT, 'cross-candidate-runs', run_label);
const reports_dir = join(run_dir, 'reports');
const comparisons_dir = join(run_dir, 'comparisons');

await Deno.mkdir(reports_dir, { recursive: true });
await Deno.mkdir(comparisons_dir, { recursive: true });

const commands: string[] = [];
const entries: ScheduleEntry[] = [];

for (let round = 0; round < rounds; round++) {
	const round_order = rotate(approaches, round);

	for (const [order, approach] of round_order.entries()) {
		const report_path = join(reports_dir, `round-${String(round + 1).padStart(2, '0')}--${approach}.json`);
		const collect_args = [
			'x',
			'deno@latest',
			'--',
			'deno',
			'run',
			'--no-lock',
			'--allow-run=mise,git',
			'--allow-read',
			'--allow-write',
			'experiments/event-shape-study/tools/collect_approach_report.ts',
			`--approach-dir=${approach}`,
			`--variant=${approach}`,
			`--runs=${runs}`,
			`--memory-repeats=${memory_repeats}`,
			`--out=${relative(REPO_ROOT, report_path)}`,
		];
		await runCommand(collect_args);
		commands.push(`mise ${collect_args.join(' ')}`);

		const entry: ScheduleEntry = {
			round: round + 1,
			order: order + 1,
			approach,
			report_path: relative(REPO_ROOT, report_path),
		};

		if (approach !== baseline) {
			const baseline_report = join(reports_dir, `round-${String(round + 1).padStart(2, '0')}--${baseline}.json`);
			const comparison_json = join(comparisons_dir, `round-${String(round + 1).padStart(2, '0')}--${baseline}--vs--${approach}.json`);
			const comparison_text = join(comparisons_dir, `round-${String(round + 1).padStart(2, '0')}--${baseline}--vs--${approach}.txt`);
			const compare_base_args = [
				'x',
				'deno@latest',
				'--',
				'deno',
				'run',
				'--no-lock',
				'--allow-read',
				'experiments/event-shape-study/tools/compare_reports.ts',
				`--min-improvement=${minimum_improvement}`,
				`--max-regression=${maximum_regression}`,
				`--bootstrap=${bootstrap_iterations}`,
				`--alpha=${alpha}`,
			];
			const compare_json_args = [
				...compare_base_args,
				'--format=json',
				relative(REPO_ROOT, baseline_report),
				relative(REPO_ROOT, report_path),
			];
			const compare_text_args = [
				...compare_base_args,
				'--format=text',
				relative(REPO_ROOT, baseline_report),
				relative(REPO_ROOT, report_path),
			];
			await Deno.writeTextFile(comparison_json, await runCommand(compare_json_args));
			await Deno.writeTextFile(comparison_text, await runCommand(compare_text_args));
			commands.push(`mise ${compare_json_args.join(' ')}`);
			commands.push(`mise ${compare_text_args.join(' ')}`);
			entry.comparison_json = relative(REPO_ROOT, comparison_json);
			entry.comparison_text = relative(REPO_ROOT, comparison_text);
		}

		entries.push(entry);
	}
}

const output: ScheduleOutput = {
	study: 'event-shape',
	baseline,
	approaches,
	rounds,
	runs_per_report: runs,
	memory_repeats,
	minimum_improvement,
	maximum_regression,
	bootstrap_iterations,
	alpha,
	entries,
	commands,
};

await Deno.writeTextFile(join(run_dir, 'schedule.json'), `${JSON.stringify(output, null, 2)}\n`);
await Deno.writeTextFile(join(run_dir, 'commands.txt'), `${commands.join('\n')}\n`);

console.log(`wrote ${relative(REPO_ROOT, join(run_dir, 'schedule.json'))}`);
