# Event Shape Protocol

## Problem

The parser emits a large number of event objects. That makes event shape a real cost
center for both CPU time and memory retention. Small local wins can be noise, and some
object-shape changes improve one path while hurting the actual parse workflows that users
care about. This protocol exists so each candidate is tested the same way.

## Goals

- measure event-representation candidates against the same baseline
- preserve raw samples, not just summaries
- keep the collection process deterministic and easy to rerun
- reject candidates that help microbenchmarks but hurt parse or session workflows
- keep the notes approachable enough that maintainers can challenge the result later

## Non-goals

- this is not a claim that the current benchmark set is the final word on all workloads
- this study does not try to prove cross-machine absolute speed claims
- this protocol does not replace broader parser correctness testing

## Constraints

- the parser contract cannot change: event nesting, UTF-16 offsets, determinism, and never-throw behavior must stay intact
- the repo currently runs Deno through `mise x deno@latest -- ...` in this container
- timing and retained-memory data must be stored inside the repo once a run is part of the study record

## Method

The study now keeps the code under test inside each approach directory. That makes the
measured parser, the benchmark harness, and the retained-memory harness travel together as a
single snapshot.

```text
approach-local code snapshot
  -> collect_approach_report.ts
  -> artifacts/report.json
  -> compare_reports.ts
  -> artifacts/comparison.json
  -> human notes in the approach README

optional round-robin schedule
  -> run_cross_candidate_schedule.ts
  -> cross-candidate-runs/<label>/...
```

`collect_approach_report.ts` runs the approach-local benchmark and retained-memory harness in
fresh processes and preserves the raw samples in JSON. `compare_reports.ts` then compares
baseline and candidate reports with bootstrap confidence intervals, bootstrap p-values, and
Holm adjustment.

## Deterministic workflow

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

The recorder writes the report plus recording metadata and exact commands into the
approach's `artifacts/` directory.

If you only need the raw report file, use the study-local collector:

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

Record a candidate against the baseline:

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

Generate a deterministic baseline-then-candidate schedule:

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

The study-local tools write the collector output into the approach directory and, for the
round-robin workflow, store the exact commands and ordering under the run label.

## Statistical rule

The acceptance rule is deliberately strict:

1. The median across the target timing cases must improve by at least 5%.
2. No critical timing case may regress by more than 3% with Holm-adjusted significance.
3. Memory should not regress overall.
4. The repo only keeps a candidate change if the approach clears that bar.

This is a study of practical wins, not a search for tiny directional changes.

## Notes discipline

Each approach README should separate these parts clearly:

- hypothesis: what should change and why
- methodology: what was run and what was held constant
- observations: what the artifacts show, without spinning the result
- conclusion: keep, reject, or continue
- code under test: the touched files or planned files

## Current limitations

The current workflow is deterministic and machine-readable, but it still has two limits.
It does not yet replicate runs across multiple host machines, and it does not yet bundle an
external archival package such as a DOI-ready release artifact. Those are follow-up steps if
the study grows into an external paper.