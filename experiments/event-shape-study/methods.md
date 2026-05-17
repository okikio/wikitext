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
Those runs live in a separate stress-report path so they do not distort the standard report
budget or the acceptance gate.

The checked-in archive currently keeps one cheaper large-input smoke artifact per approach at
`16 MiB` under `artifacts/stress-mixed-16MiB.json`. That gives every candidate one comparable
large-string result in-repo while leaving `1 GiB` collection as an explicit heavyweight follow-up.

Collect a `1 GiB` mixed-article stress report for one approach:

```bash
mise x deno@latest -- deno run --no-lock --allow-read --allow-write --allow-sys \
  --v8-flags=--expose-gc \
  experiments/event-shape-study/tools/collect_large_input_stress_report.ts \
  --approach-dir=current-baseline \
  --variant=current-baseline \
  --scenario=mixed-article \
  --size-mib=1024 \
  --repeats=3 \
  --out=experiments/event-shape-study/current-baseline/artifacts/stress-mixed-1GiB.json
```

Available scenarios are:

- `plain-paragraphs` for low token density and long prose
- `mixed-article` for a more realistic mix of headings, links, templates, tables, and refs
- `pathological-recovery` for malformed input that stays in recovery-heavy paths

These reports are for scale behavior and survivability. The current acceptance rule still
comes from the standard smaller-input study ledger.

## Decision rule

The acceptance rule stays the same across all approaches:

1. The target timing median must improve by at least `+5%`.
2. Critical timing cases must not regress by more than `-3%`.
3. Memory should not regress overall.
4. Significance uses bootstrap confidence intervals, bootstrap p-values, and Holm adjustment at $\alpha = 0.05$.

The study records rejected candidates on purpose. A rejected approach still matters if it
shows which object-layout ideas help only a little, help only memory, or hurt the parser in
ways that microbenchmarks alone would miss.