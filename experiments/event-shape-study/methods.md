# Event Shape Methods

This study keeps each candidate self-contained so the code under test does not move around
between runs. Every approach directory can include its own `code/` snapshot, its own
artifacts, and its own notes. That keeps the benchmark input, the benchmark harness, and
the parser code aligned with the exact candidate being measured.

## What gets measured

Each recorded report captures two things:

- timing samples from the approach-local `event_shape_bench.ts`
- retained-memory samples from the approach-local `event_shape_memory.ts`

Both commands run in fresh processes. The report preserves the raw samples so later
bootstrap analysis does not need to reconstruct data from summary text.

## Snapshot-local recording

Record one approach with the study-local recorder:

```bash
mise x deno@latest -- deno run --allow-run=mise,git --allow-read --allow-write \
  --no-lock \
  experiments/event-shape-study/tools/record_approach_artifacts.ts \
  --approach-dir=current-baseline \
  --variant=current-baseline \
  --runs=10 \
  --memory-repeats=5
```

That command writes `artifacts/report.json`, `artifacts/recording.json`, and
`artifacts/commands.txt` inside the approach directory.

The lower-level collector still exists when you only want a report file:

```bash
mise x deno@latest -- deno run --allow-run=mise,git --allow-read --allow-write \
  --no-lock \
  experiments/event-shape-study/tools/collect_approach_report.ts \
  --approach-dir=current-baseline \
  --variant=current-baseline \
  --runs=10 \
  --memory-repeats=5 \
  --out=experiments/event-shape-study/current-baseline/artifacts/report.json
```

Record and compare a candidate against the baseline:

```bash
mise x deno@latest -- deno run --allow-run=mise,git --allow-read --allow-write \
  --no-lock \
  experiments/event-shape-study/tools/record_approach_artifacts.ts \
  --approach-dir=planned-flat-eager-event-shape \
  --variant=planned-flat-eager-event-shape \
  --runs=10 \
  --memory-repeats=5 \
  --baseline-report=experiments/event-shape-study/current-baseline/artifacts/report.json
```

The recorder writes `comparison.json` and `comparison.txt` automatically when a baseline
report is supplied.

You can still run the comparator directly when you want to inspect two existing reports:

```bash
mise x deno@latest -- deno run --allow-read \
  --no-lock \
  experiments/event-shape-study/tools/compare_reports.ts \
  experiments/event-shape-study/current-baseline/artifacts/report.json \
  experiments/event-shape-study/planned-flat-eager-event-shape/artifacts/report.json
```

## Deterministic cross-candidate run

The study also records an explicit round-robin schedule so baseline and candidate reports
are collected in a fixed order with the exact commands written to disk.

```bash
mise x deno@latest -- deno run --allow-run=mise,git --allow-read --allow-write \
  --no-lock \
  experiments/event-shape-study/tools/run_cross_candidate_schedule.ts \
  --baseline=current-baseline \
  --approaches=current-baseline,planned-flat-eager-event-shape \
  --rounds=1 \
  --runs=10 \
  --memory-repeats=5 \
  --run-label=2026-05-16-baseline-vs-flat-eager-round-robin-01
```

That command writes:

- `cross-candidate-runs/<label>/schedule.json` with the fixed order and artifact paths
- `cross-candidate-runs/<label>/commands.txt` with the exact commands used
- per-round reports under `cross-candidate-runs/<label>/reports/`
- baseline-versus-candidate comparisons under `cross-candidate-runs/<label>/comparisons/`

## Large-input stress runs

The standard ledger is good for significance testing, but it does not represent the kind of
large-input stress you called out, such as hundreds of MiB or about `1 GiB` of source text.
Those runs live in separate stress-report paths so they do not distort the standard report
budget or the acceptance gate.

The checked-in archive currently keeps one cheaper large-input smoke artifact per approach at
`16 MiB` under `artifacts/stress-mixed-16MiB.json`. That proves the archive path end to end.
The broader one-shot scenario matrix is now driven by tooling rather than being implied by the
current checked-in artifact count.

Use the batch runner when you want to fill a one-shot scenario matrix instead of one-off files:

```bash
mise x deno@latest -- deno run --no-lock --allow-read --allow-write --allow-run --allow-sys \
  experiments/event-shape-study/tools/run_large_input_stress_matrix.ts \
  --approaches=current-baseline,shared-props \
  --scenarios=plain-paragraphs,mixed-article,pathological-recovery,table-heavy,template-heavy,inline-heavy,uri-heavy,unicode-heavy,synthetic-article,outline-heavy \
  --sizes-mib=16,1024 \
  --repeats=1
```

For `16 MiB`, the runner uses the full profile with:

- `events() streamed count`
- `parse() child count`
- `parseWithDiagnostics() tree+diagnostics count`

For `1 GiB`, the runner defaults to a streaming-only profile so the standard GiB lane stays focused
on event-path survivability. When you want the real non-streaming workload instead, pass
`--gib-profile=full` to the matrix runner.

The default streaming `1 GiB` artifacts keep the existing `stress-<scenario>-1GiB.json` naming.
When you override the GiB tier to full mode, the runner writes
`stress-<scenario>-1GiB-full.json` so the full-materialization probe does not overwrite the
default streaming artifact.

Collect a `1 GiB` mixed-article stress report for one approach:

```bash
mise x deno@latest -- deno run --no-lock --allow-read --allow-write --allow-sys \
  --v8-flags=--expose-gc,--max-old-space-size=8192 \
  experiments/event-shape-study/tools/collect_large_input_stress_report.ts \
  --approach-dir=current-baseline \
  --variant=current-baseline \
  --scenario=mixed-article \
  --profile=streaming-only \
  --size-mib=1024 \
  --repeats=1 \
  --out=experiments/event-shape-study/current-baseline/artifacts/stress-mixed-1GiB.json
```

Force the `1 GiB` matrix runner through the full non-streaming workload path:

```bash
mise x deno@latest -- deno run --no-lock --allow-read --allow-write --allow-run --allow-sys \
  experiments/event-shape-study/tools/run_large_input_stress_matrix.ts \
  --approaches=current-baseline \
  --scenarios=mixed-article \
  --sizes-mib=1024 \
  --gib-profile=full \
  --repeats=1
```

Available one-shot scenarios are:

- `plain-paragraphs`
- `mixed-article`
- `pathological-recovery`
- `table-heavy`
- `template-heavy`
- `inline-heavy`
- `uri-heavy`
- `unicode-heavy`
- `synthetic-article`
- `outline-heavy`

These reports are for scale behavior and survivability. The current acceptance rule still
comes from the standard smaller-input study ledger.

The one-shot stress collector records per-case failures inside the JSON artifact instead of aborting
the whole file when one runtime exception hits a pathological input. That matters because a recorded
failure tells us more than a missing artifact would.

If you want to verify the study is fully built before collecting anything new, run the preflight inventory:

```bash
mise x deno@latest -- deno run --no-lock --allow-read \
  experiments/event-shape-study/tools/validate_experiment_matrix.ts
```

This preflight only checks the runnable surface that exists on this branch: the core study docs,
the standard comparison tools, the one-shot large-input tools, the approach-local `code/mod.ts`
snapshots, and the checked-in `16 MiB` mixed-article smoke artifacts.

## Decision rule

The acceptance rule stays the same across all approaches:

1. The target timing median must improve by at least `+5%`.
2. Critical timing cases must not regress by more than `-3%`.
3. Memory should not regress overall.
4. Significance uses bootstrap confidence intervals, bootstrap p-values, and Holm adjustment at $\alpha = 0.05$.

The study records rejected candidates on purpose. A rejected approach still matters if it
shows which object-layout ideas help only a little, help only memory, or hurt the parser in
ways that microbenchmarks alone would miss.