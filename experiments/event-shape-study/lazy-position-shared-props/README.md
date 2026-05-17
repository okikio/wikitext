# Lazy Position Plus Shared Props

## Hypothesis

This approach combines the shared-props idea with lazy position materialization. The
expected benefit is to avoid allocating `{ start, end }` position wrappers until a caller
actually reads `event.position`.

## Methodology

The candidate is compared against `current-baseline` with the same study settings used
throughout the study: 10 timing runs and 5 memory repeats per input. The implementation
keeps the public API shape the same while changing the internal event representation. This
directory now also carries an approach-local `code/` snapshot so the same variant can be
rerun for large-input stress collection without touching the root parser files.

## Observations

The checked-in comparison shows a target timing median of `-107.05%` and a worst critical
timing regression of `-149.81%`. Those are not borderline misses. They are decisive failures.
The candidate does save memory in some retained cases, but the timing damage is large enough
to reject the approach outright.

## Conclusion

Reject. Do not retry this exact getter-based lazy-position shape without a materially
different object-layout strategy.

## Code Under Test

- `code/event_factory.ts`
- `code/block_parser.ts`
- `code/inline_parser.ts`
- `code/event_props.ts`

## Artifacts

- `artifacts/report.json`
- `artifacts/comparison.json`
- `artifacts/comparison.txt`
- `artifacts/provenance.json`
- `artifacts/stress-mixed-16MiB.json`