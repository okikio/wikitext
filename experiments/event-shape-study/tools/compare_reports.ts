/**
 * Compare one baseline event-shape report against one or more candidate reports.
 */

type NumericSummary = {
	samples: number[];
	mean: number;
	median: number;
	minimum: number;
	maximum: number;
	stdev: number;
};

type EventShapeReport = {
	variant: string;
	branch: string;
	commit: string;
	timing: {
		summary: Record<string, NumericSummary>;
	};
	memory: {
		summary: Record<string, Record<string, NumericSummary>>;
	};
};

type MetricComparison = {
	name: string;
	family: 'timing' | 'memory';
	estimate: number;
	ci_lower: number;
	ci_upper: number;
	p_value: number;
	adjusted_p_value: number;
	significant_better: boolean;
	significant_worse: boolean;
};

type CandidateDecision = {
	variant: string;
	path: string;
	target_timing_median: number;
	memory_median: number;
	worst_critical_timing: number;
	significant_target_wins: number;
	significant_memory_wins: number;
	significant_critical_regressions: number;
	recommended: boolean;
	top_timing_wins: MetricComparison[];
	top_memory_wins: MetricComparison[];
	critical_regressions: MetricComparison[];
};

const TARGET_TIMING_CASES = [
	'events() no position access: same-size plain (~8 KB)',
	'events() no position access: same-size mixed (~8 KB)',
	'events() no position access: same-size pathological (~8 KB)',
	'events() offsets only: same-size mixed (~8 KB)',
	'events() offsets only: same-size pathological (~8 KB)',
	'events() retained array only: same-size mixed (~8 KB)',
	'events() retained array only: synthetic article (~35-45 KB)',
	'session.events() warm retained array: same-size mixed (~8 KB)',
	'session.events() warm retained array: synthetic article (~35-45 KB)',
] as const;

const CRITICAL_TIMING_CASES = [
	'parse(): same-size mixed (~8 KB)',
	'parseWithDiagnostics(): same-size pathological (~8 KB)',
	'session.parse() cold: same-size mixed (~8 KB)',
	'session.parse() warm: same-size mixed (~8 KB)',
	'session.parseWithDiagnostics() cold: same-size pathological (~8 KB)',
	'session.parseWithDiagnostics() warm: same-size pathological (~8 KB)',
	'parse(): synthetic article (~35-45 KB)',
	'session.parse() warm: synthetic article (~35-45 KB)',
	'session.parseWithDiagnostics() warm: synthetic article (~35-45 KB)',
] as const;

function parseFloatFlag(name: string, fallback: number): number {
	const raw = Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

	if (raw === undefined) {
		return fallback;
	}

	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`expected --${name} to be numeric, got: ${raw}`);
	}

	return value;
}

function parseIntFlag(name: string, fallback: number): number {
	const raw = Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

	if (raw === undefined) {
		return fallback;
	}

	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`expected --${name} to be a positive integer, got: ${raw}`);
	}

	return value;
}

function parseFormat(): 'text' | 'json' {
	const raw = Deno.args.find((arg) => arg.startsWith('--format='))?.slice('--format='.length);

	if (raw === undefined) {
		return 'text';
	}

	if (raw === 'text' || raw === 'json') {
		return raw;
	}

	throw new Error(`expected --format=text or --format=json, got: ${raw}`);
}

function positionalPaths(): string[] {
	return Deno.args.filter((arg) => !arg.startsWith('--'));
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	if (sorted.length % 2 === 0) {
		return (sorted[middle - 1]! + sorted[middle]!) / 2;
	}

	return sorted[middle]!;
}

function mean(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], ratio: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	const index = (sorted.length - 1) * ratio;
	const lower = Math.floor(index);
	const upper = Math.ceil(index);

	if (lower === upper) {
		return sorted[lower]!;
	}

	const weight = index - lower;
	return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function createRng(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

function sampleWithReplacement(values: readonly number[], rng: () => number): number[] {
	const sample: number[] = [];

	for (let index = 0; index < values.length; index++) {
		sample.push(values[Math.floor(rng() * values.length)]!);
	}

	return sample;
}

function relativeImprovement(baseline: number, candidate: number): number {
	return (baseline - candidate) / baseline;
}

function compareSamples(
	name: string,
	family: 'timing' | 'memory',
	baseline_samples: readonly number[],
	candidate_samples: readonly number[],
	bootstrap_iterations: number,
): MetricComparison {
	const estimate = relativeImprovement(
		median(baseline_samples),
		median(candidate_samples),
	);
	const rng = createRng(name.length * 2654435761);
	const distribution: number[] = [];

	for (let index = 0; index < bootstrap_iterations; index++) {
		const baseline_bootstrap = sampleWithReplacement(baseline_samples, rng);
		const candidate_bootstrap = sampleWithReplacement(candidate_samples, rng);
		distribution.push(relativeImprovement(mean(baseline_bootstrap), mean(candidate_bootstrap)));
	}

	const ci_lower = percentile(distribution, 0.025);
	const ci_upper = percentile(distribution, 0.975);
	const non_positive = distribution.filter((value) => value <= 0).length / distribution.length;
	const non_negative = distribution.filter((value) => value >= 0).length / distribution.length;
	const p_value = Math.min(1, 2 * Math.min(non_positive, non_negative));

	return {
		name,
		family,
		estimate,
		ci_lower,
		ci_upper,
		p_value,
		adjusted_p_value: p_value,
		significant_better: false,
		significant_worse: false,
	};
}

function applyHolmAdjustment(
	comparisons: readonly MetricComparison[],
	alpha: number,
): MetricComparison[] {
	const ordered = comparisons
		.map((comparison, index) => ({ comparison, index }))
		.sort((left, right) => left.comparison.p_value - right.comparison.p_value);
	const adjusted: MetricComparison[] = Array.from(comparisons, (comparison) => ({ ...comparison }));
	let running_max = 0;

	for (const [rank, entry] of ordered.entries()) {
		const multiplier = ordered.length - rank;
		const holm_value = Math.min(1, entry.comparison.p_value * multiplier);
		running_max = Math.max(running_max, holm_value);
		const estimate = adjusted[entry.index]!.estimate;
		adjusted[entry.index] = {
			...adjusted[entry.index]!,
			adjusted_p_value: running_max,
			significant_better: estimate > 0 && running_max <= alpha,
			significant_worse: estimate < 0 && running_max <= alpha,
		};
	}

	return adjusted;
}

function readReport(path: string): Promise<EventShapeReport> {
	return Deno.readTextFile(path).then((value) => JSON.parse(value) as EventShapeReport);
}

function formatPercent(value: number): string {
	return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function sortBestFirst(left: MetricComparison, right: MetricComparison): number {
	return right.estimate - left.estimate;
}

function sortWorstFirst(left: MetricComparison, right: MetricComparison): number {
	return left.estimate - right.estimate;
}

function evaluateCandidate(
	path: string,
	baseline: EventShapeReport,
	candidate: EventShapeReport,
	minimum_improvement: number,
	maximum_regression: number,
	bootstrap_iterations: number,
	alpha: number,
): CandidateDecision {
	const target_timing = TARGET_TIMING_CASES.map((name) => compareSamples(
		name,
		'timing',
		baseline.timing.summary[name]!.samples,
		candidate.timing.summary[name]!.samples,
		bootstrap_iterations,
	));

	const critical_timing = CRITICAL_TIMING_CASES.map((name) => compareSamples(
		name,
		'timing',
		baseline.timing.summary[name]!.samples,
		candidate.timing.summary[name]!.samples,
		bootstrap_iterations,
	));
	const adjusted_timing = applyHolmAdjustment([...target_timing, ...critical_timing], alpha);
	const adjusted_target_timing = adjusted_timing.slice(0, target_timing.length);
	const adjusted_critical_timing = adjusted_timing.slice(target_timing.length);

	const memory_comparisons: MetricComparison[] = [];

	for (const [input_name, cases] of Object.entries(baseline.memory.summary)) {
		for (const [case_name, summary] of Object.entries(cases)) {
			memory_comparisons.push(compareSamples(
				`${input_name} :: ${case_name}`,
				'memory',
				summary.samples,
				candidate.memory.summary[input_name]![case_name]!.samples,
				bootstrap_iterations,
			));
		}
	}
	const adjusted_memory = applyHolmAdjustment(memory_comparisons, alpha);

	const significant_target_wins = adjusted_target_timing.filter((item) => item.significant_better && item.estimate >= minimum_improvement).length;
	const significant_memory_wins = adjusted_memory.filter((item) => item.significant_better && item.estimate > 0).length;
	const significant_critical_regressions = adjusted_critical_timing.filter((item) => item.significant_worse && item.estimate <= -maximum_regression).length;
	const target_timing_median = median(adjusted_target_timing.map((item) => item.estimate));
	const memory_median = median(adjusted_memory.map((item) => item.estimate));
	const worst_critical_timing = Math.min(...adjusted_critical_timing.map((item) => item.estimate));

	return {
		variant: candidate.variant,
		path,
		target_timing_median,
		memory_median,
		worst_critical_timing,
		significant_target_wins,
		significant_memory_wins,
		significant_critical_regressions,
		recommended: target_timing_median >= minimum_improvement
			&& worst_critical_timing > -maximum_regression
			&& significant_critical_regressions === 0
			&& memory_median >= 0,
		top_timing_wins: adjusted_target_timing.filter((item) => item.estimate > 0).sort(sortBestFirst).slice(0, 3),
		top_memory_wins: adjusted_memory.filter((item) => item.estimate > 0).sort(sortBestFirst).slice(0, 3),
		critical_regressions: adjusted_critical_timing.filter((item) => item.estimate < 0).sort(sortWorstFirst).slice(0, 3),
	};
}

const minimum_improvement = parseFloatFlag('min-improvement', 0.05);
const maximum_regression = parseFloatFlag('max-regression', 0.03);
const bootstrap_iterations = parseIntFlag('bootstrap', 5000);
const alpha = parseFloatFlag('alpha', 0.05);
const format = parseFormat();
const paths = positionalPaths();

if (paths.length < 2) {
	throw new Error('expected at least two report paths: baseline first, then one or more candidate reports');
}

const [baseline_path, ...candidate_paths] = paths;
const baseline = await readReport(baseline_path!);
const candidates = await Promise.all(candidate_paths.map(async (path) => ({
	path,
	report: await readReport(path),
})));

const decisions = candidates
	.map(({ path, report }) => evaluateCandidate(
		path,
		baseline,
		report,
		minimum_improvement,
		maximum_regression,
		bootstrap_iterations,
		alpha,
	))
	.sort((left, right) => {
		if (left.recommended !== right.recommended) {
			return Number(right.recommended) - Number(left.recommended);
		}

		if (left.target_timing_median !== right.target_timing_median) {
			return right.target_timing_median - left.target_timing_median;
		}

		return right.memory_median - left.memory_median;
	});

if (format === 'json') {
	console.log(JSON.stringify({
		baseline: {
			variant: baseline.variant,
			branch: baseline.branch,
			commit: baseline.commit,
			path: baseline_path,
		},
		minimum_improvement,
		maximum_regression,
		bootstrap_iterations,
		alpha,
		decisions,
	}, null, 2));
	Deno.exit(0);
}

console.log(`baseline: ${baseline.variant} (${baseline.branch} ${baseline.commit.slice(0, 8)})`);
console.log(`decision rule: target median >= ${formatPercent(minimum_improvement)}, critical regressions > ${formatPercent(-maximum_regression)} disallowed, Holm-adjusted alpha=${alpha.toFixed(3)}`);

for (const decision of decisions) {
	console.log(`\n${decision.variant}: ${decision.recommended ? 'recommended' : 'not recommended'}`);
	console.log(`report: ${decision.path}`);
	console.log(`target timing median: ${formatPercent(decision.target_timing_median)} (${decision.significant_target_wins}/${TARGET_TIMING_CASES.length} significant wins)`);
	console.log(`memory median: ${formatPercent(decision.memory_median)} (${decision.significant_memory_wins} significant wins)`);
	console.log(`worst critical timing: ${formatPercent(decision.worst_critical_timing)} (${decision.significant_critical_regressions} significant regressions)`);

	if (decision.top_timing_wins.length > 0) {
		console.log('top timing wins:');
		for (const item of decision.top_timing_wins) {
			console.log(`- ${item.name}: ${formatPercent(item.estimate)} [${formatPercent(item.ci_lower)}, ${formatPercent(item.ci_upper)}], p_adj=${item.adjusted_p_value.toExponential(2)}`);
		}
	}

	if (decision.top_memory_wins.length > 0) {
		console.log('top memory wins:');
		for (const item of decision.top_memory_wins) {
			console.log(`- ${item.name}: ${formatPercent(item.estimate)} [${formatPercent(item.ci_lower)}, ${formatPercent(item.ci_upper)}], p_adj=${item.adjusted_p_value.toExponential(2)}`);
		}
	}

	if (decision.critical_regressions.length > 0) {
		console.log('critical timing risks:');
		for (const item of decision.critical_regressions) {
			console.log(`- ${item.name}: ${formatPercent(item.estimate)} [${formatPercent(item.ci_lower)}, ${formatPercent(item.ci_upper)}], p_adj=${item.adjusted_p_value.toExponential(2)}`);
		}
	}
}
