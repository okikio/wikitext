/**
 * Record one approach-local artifact bundle for the event-shape study.
 *
 * This helper keeps the archive workflow inside the study directory. It runs the
 * snapshot-local collector, optionally compares the result against a baseline report,
 * and writes the machine-readable metadata and exact commands into the approach's
 * own `artifacts/` directory.
 */

import { basename, fromFileUrl, join, relative } from 'jsr:@std/path';

type RecordingMetadata = {
	study: 'event-shape';
	variant: string;
	experiment_dir: string;
	report_path: string;
	comparison_json?: string;
	comparison_text?: string;
	baseline_report?: string;
	generated_at: string;
	runs: number;
	memory_repeats: number;
	minimum_improvement: number;
	maximum_regression: number;
	bootstrap_iterations: number;
	alpha: number;
	branch: string;
	commit: string;
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

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
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

async function readGitValue(args: string[]): Promise<string> {
	const command = new Deno.Command('git', {
		args,
		cwd: REPO_ROOT,
		stdout: 'piped',
		stderr: 'piped',
	});
	const output = await command.output();
	const stdout = new TextDecoder().decode(output.stdout);
	const stderr = new TextDecoder().decode(output.stderr);

	if (!output.success) {
		throw new Error(`command failed: git ${args.join(' ')}\n${stdout}\n${stderr}`);
	}

	return stripAnsi(stdout).trim();
}

const approach_dir = requireFlag('approach-dir');
const variant = getFlag('variant') ?? basename(approach_dir);
const runs = parsePositiveIntFlag('runs', 10);
const memory_repeats = parsePositiveIntFlag('memory-repeats', 5);
const minimum_improvement = parseFloatFlag('min-improvement', 0.05);
const maximum_regression = parseFloatFlag('max-regression', 0.03);
const bootstrap_iterations = parsePositiveIntFlag('bootstrap', 5000);
const alpha = parseFloatFlag('alpha', 0.05);
const baseline_report = getFlag('baseline-report');

const experiment_dir = join(STUDY_ROOT, approach_dir);
const artifacts_dir = join(experiment_dir, 'artifacts');
const report_path = join(artifacts_dir, 'report.json');
const comparison_json = join(artifacts_dir, 'comparison.json');
const comparison_text = join(artifacts_dir, 'comparison.txt');
const recording_path = join(artifacts_dir, 'recording.json');
const commands_path = join(artifacts_dir, 'commands.txt');

await Deno.mkdir(artifacts_dir, { recursive: true });

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
	`--approach-dir=${approach_dir}`,
	`--variant=${variant}`,
	`--runs=${runs}`,
	`--memory-repeats=${memory_repeats}`,
	`--out=${relative(REPO_ROOT, report_path)}`,
];

const commands = [`mise ${collect_args.join(' ')}`];
await runCommand(collect_args);

let relative_baseline_report: string | undefined;
let relative_comparison_json: string | undefined;
let relative_comparison_text: string | undefined;

if (baseline_report !== undefined) {
	const resolved_baseline_report = join(REPO_ROOT, baseline_report);
	relative_baseline_report = relative(REPO_ROOT, resolved_baseline_report);
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
		relative_baseline_report,
		relative(REPO_ROOT, report_path),
	];
	const compare_text_args = [
		...compare_base_args,
		'--format=text',
		relative_baseline_report,
		relative(REPO_ROOT, report_path),
	];

	await Deno.writeTextFile(comparison_json, await runCommand(compare_json_args));
	await Deno.writeTextFile(comparison_text, await runCommand(compare_text_args));
	commands.push(`mise ${compare_json_args.join(' ')}`);
	commands.push(`mise ${compare_text_args.join(' ')}`);
	relative_comparison_json = relative(REPO_ROOT, comparison_json);
	relative_comparison_text = relative(REPO_ROOT, comparison_text);
}

const recording: RecordingMetadata = {
	study: 'event-shape',
	variant,
	experiment_dir: relative(REPO_ROOT, experiment_dir),
	report_path: relative(REPO_ROOT, report_path),
	comparison_json: relative_comparison_json,
	comparison_text: relative_comparison_text,
	baseline_report: relative_baseline_report,
	generated_at: new Date().toISOString(),
	runs,
	memory_repeats,
	minimum_improvement,
	maximum_regression,
	bootstrap_iterations,
	alpha,
	branch: await readGitValue(['branch', '--show-current']),
	commit: await readGitValue(['rev-parse', 'HEAD']),
	commands,
};

await Deno.writeTextFile(recording_path, `${JSON.stringify(recording, null, 2)}\n`);
await Deno.writeTextFile(commands_path, `${commands.join('\n')}\n`);

console.log(`wrote ${relative(REPO_ROOT, recording_path)}`);