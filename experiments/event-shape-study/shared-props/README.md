# Shared Props

## Hypothesis

This approach reuses a small set of immutable props objects for repeated hot-path cases
such as empty props and finite boolean or enum-like props. The hypothesis is that fewer
tiny object allocations will lower retained memory and may improve timing on event-heavy
paths.

## Methodology

The candidate is compared against `current-baseline` with the same study settings: 10
timing runs and 5 memory repeats per input. The candidate report and the baseline-vs-candidate
comparison are stored in `artifacts/`. This directory now also carries an approach-local
`code/` snapshot so the same variant can be rerun for large-input stress collection without
touching the root parser files.

## Observations

The checked-in comparison shows a target timing median of `+0.81%`, which is well below
the study's `+5%` acceptance bar. It also shows a memory median of `+4.02%`, with 8
significant memory wins and no significant critical timing regressions. That makes this a
useful negative result: props allocation matters for retained memory, but not enough to
explain the main timing cost by itself.

## Conclusion

Reject as a production change under the current decision rule. Keep the result as evidence
that props allocation matters for memory, but not enough to explain the main timing cost.

## Code Under Test

- `code/block_parser.ts`
- `code/inline_parser.ts`
- `code/event_props.ts`

## Artifacts

- `artifacts/report.json`
- `artifacts/comparison.json`
- `artifacts/comparison.txt`
- `artifacts/provenance.json`
- `artifacts/stress-mixed-16MiB.json`