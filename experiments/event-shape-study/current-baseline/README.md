# Current Baseline

## Hypothesis

This is the control condition. It should capture the current parser event shape without
any representation experiment applied.

## Methodology

The baseline now uses an approach-local `code/` snapshot so later candidates can be measured
without changing the root parser files between runs. The study records one timing plus
retained-memory report with the standard settings: 10 timing runs and 5 memory repeats per
input. The collector runs in fresh processes and stores machine-readable raw samples under
`artifacts/report.json`.

## Observations

This directory is the control that later comparisons use. It is not judged as a win or
loss. Its job is to anchor the later significance tests and give the study one stable
reference point.

## Code Under Test

- `code/events.ts`
- `code/block_parser.ts`
- `code/inline_parser.ts`
- `code/parse.ts`
- `code/session.ts`
- `code/event_shape_bench.ts`
- `code/event_shape_memory.ts`

## Artifacts

- `artifacts/report.json`
- `artifacts/recording.json`
- `artifacts/commands.txt`
- `artifacts/stress-mixed-16MiB.json`