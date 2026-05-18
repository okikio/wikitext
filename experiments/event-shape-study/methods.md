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
The broader scenario matrix is now driven by tooling rather than being implied by the current
checked-in artifact count.

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

## Large-input session stress runs

One-shot large-input stress answers whether an approach survives large text and how much whole-run
work it does. Session stress answers a different question: whether the same event shape helps when
callers keep a session alive and ask for outline, events, parse, and diagnostics results more than
once.

The session collector mirrors the case semantics in `session_bench.ts` for the first study-local
workload set:

- `session.outline() cold`
- `session.outline() warm`
- `session.events() cold`
- `session.events() warm`
- `session.parse() cold`
- `session.parse() warm`
- `session.parseWithDiagnostics() cold`
- `session.parseWithDiagnostics() warm`
- `consumer workflow: session outline -> events -> parse cold`
- `consumer workflow: session outline -> events -> parse warm`

The session lane now uses the same ten scenario families as the one-shot matrix.
That keeps `16 MiB` and `1 GiB` session coverage aligned with the broader large-input archive,
even though the checked-in session artifacts are still much sparser than the implemented surface.

Collect one session-stress artifact for one approach:

```bash
mise x deno@latest -- deno run --no-lock --allow-read --allow-write --allow-sys \
  --v8-flags=--expose-gc \
  experiments/event-shape-study/tools/collect_large_input_session_stress_report.ts \
  --approach-dir=current-baseline \
  --variant=current-baseline \
  --scenario=mixed-article \
  --size-mib=16 \
  --repeats=1 \
  --out=experiments/event-shape-study/current-baseline/artifacts/session-stress-mixed-16MiB.json
```

Use the session batch runner when you want the same session scenario set across several approaches:

```bash
mise x deno@latest -- deno run --no-lock --allow-read --allow-write --allow-run --allow-sys \
  experiments/event-shape-study/tools/run_large_input_session_stress_matrix.ts \
  --approaches=current-baseline,shared-props \
  --scenarios=plain-paragraphs,mixed-article,pathological-recovery,table-heavy,template-heavy,inline-heavy,uri-heavy,unicode-heavy,synthetic-article,outline-heavy \
  --sizes-mib=16 \
  --repeats=1
```

The session matrix runner now gives child collectors a larger V8 heap budget by default with
`--max-old-space-size-mib=8192`. Override that flag if you need a different ceiling for a
particular machine or scenario lane.

The first full `16 MiB` matrix attempt on this branch exposed a practical budget issue:
`current-baseline` on `pathological-recovery` kept one CPU core busy for more than eleven
minutes before the run was stopped. Treat that scenario as a separately budgeted lane rather
than assuming it belongs in the same quick follow-up batch as `mixed-article` and `synthetic-article`.

The current checked-in session archive covers only the first non-pathological `16 MiB` slice for all four
approaches:

- `mixed-article`
- `synthetic-article`

`pathological-recovery` remains intentionally incomplete on this branch until it is rerun with a
separate time budget.

Warm session cases intentionally include the cache-priming step before the measured second access.
That matches the benchmark helper semantics in `session_bench.ts`, so the checked-in study artifacts
and the benchmark file describe the same workload shape.

## Budgeted large-input mitata runs

The one-shot stress collector is useful for survivability and scale diagnostics, but it does not use
mitata. For the `1 GiB` tier, the study now also has a budgeted mitata lane for streaming parser work.
Its purpose is narrower than the standard event-shape benchmark suite:

- keep the command under about two minutes on the study machine
- stress real parser traversal on a `1 GiB` input
- stay on streaming parser paths instead of requiring full tree materialization

The current mitata large-input collector measures two streaming cases:

- `outlineEvents() streamed count`
- `events() streamed count`

The collector now lowers mitata's minimum sample count to `1` by default for this lane and records
the checksum from the first measured execution instead of doing a separate full pre-pass. That keeps
the `1 GiB` collector much closer to its intended command budget on expensive scenarios.

The mitata lane now uses the same ten scenario families as the one-shot and session lanes. The
implementation surface is no longer narrower than the rest of the study, and the checked-in `1 GiB`
archive now covers every non-pathological scenario across all four approaches.

For limit-study sweeps, the matrix runner also supports `--continue-on-error` so one failing size or
approach does not hide the rest of the boundary. That mode still exits non-zero at the end, but it
keeps going and prints a structured failure summary for every failed job.

Even with those mitigations, `pathological-recovery` at `1 GiB` currently exceeds the practical
survivability budget for `current-baseline` on this machine: the direct collector run was hard-killed
before it could write an artifact. Treat that scenario as a separate limit study rather than assuming
it belongs in the same normal archive pass as `plain-paragraphs`, `mixed-article`, and `synthetic-article`.

The follow-up limit-study sweeps showed that the failure is not just a `1 GiB` budget miss.
On this branch and machine:

- `256 MiB` baseline `pathological-recovery` overran a nominal `60s` budget for more than thirty minutes before it was stopped
- `64 MiB` baseline `pathological-recovery` failed with `RangeError: Maximum call stack size exceeded`
- a cross-approach `1/2/4 MiB` limit-study sweep failed for all four approaches with the same stack-overflow shape

That makes `pathological-recovery` an explicit parser-limit lane, not merely an unfinished archive row.

The current checked-in `1 GiB` mitata archive covers the non-pathological lane for all four approaches:

- `plain-paragraphs`
- `mixed-article`
- `table-heavy`
- `template-heavy`
- `inline-heavy`
- `uri-heavy`
- `unicode-heavy`
- `synthetic-article`
- `outline-heavy`

Collect one `1 GiB` mitata stress artifact for one approach:

```bash
mise x deno@latest -- deno run --no-lock --allow-read --allow-write --allow-sys --allow-env=NODE_DISABLE_COLORS \
  --v8-flags=--expose-gc,--max-old-space-size=8192 \
  experiments/event-shape-study/tools/collect_large_input_mitata_report.ts \
  --approach-dir=current-baseline \
  --variant=current-baseline \
  --scenario=mixed-article \
  --size-mib=1024 \
  --total-budget-seconds=110 \
  --out=experiments/event-shape-study/current-baseline/artifacts/mitata-stress-mixed-1GiB.json
```

Use the matrix runner when you want the same `1 GiB` mitata stress lane across several approaches:

```bash
mise x deno@latest -- deno run --no-lock --allow-read --allow-write --allow-run --allow-sys --allow-env=NODE_DISABLE_COLORS \
  experiments/event-shape-study/tools/run_large_input_mitata_matrix.ts \
  --approaches=current-baseline,shared-props \
  --scenarios=plain-paragraphs,mixed-article,pathological-recovery,table-heavy,template-heavy,inline-heavy,uri-heavy,unicode-heavy,synthetic-article,outline-heavy \
  --sizes-mib=1024 \
  --total-budget-seconds=110
```

The matrix runner shells out through `mise`, so it needs `--allow-run`. The single-run collector does not.

When you need a quick inventory before choosing the next batch, summarize the archive directly:

```bash
mise x deno@latest -- deno run --no-lock --allow-read \
  experiments/event-shape-study/tools/summarize_large_input_archive.ts \
  --size-mib=1024
```

That summary groups one-shot stress, session stress, and mitata stress coverage by approach so the
next run can target missing scenarios instead of rescanning artifact directories by hand.

If you want to verify the study is fully built before collecting anything new, run the preflight inventory:

```bash
mise x deno@latest -- deno run --no-lock --allow-read \
  experiments/event-shape-study/tools/validate_experiment_matrix.ts
```

## Decision rule

The acceptance rule stays the same across all approaches:

1. The target timing median must improve by at least `+5%`.
2. Critical timing cases must not regress by more than `-3%`.
3. Memory should not regress overall.
4. Significance uses bootstrap confidence intervals, bootstrap p-values, and Holm adjustment at $\alpha = 0.05$.

The study records rejected candidates on purpose. A rejected approach still matters if it
shows which object-layout ideas help only a little, help only memory, or hurt the parser in
ways that microbenchmarks alone would miss.