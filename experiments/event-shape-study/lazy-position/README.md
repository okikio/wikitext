# Lazy Position

## Hypothesis

This approach isolates the lazy `position` idea without also interning or sharing props
objects. The goal is to answer the missing question from the original study plan: whether
eager position allocation is the real hot-path cost, or whether the large regression in the
combined lazy-position-plus-shared-props lane came from the interaction between both ideas.

## Methodology

The candidate keeps the public event API shape the same and uses the same study settings as
the other approaches. It reuses the lazy `position` event factory from the combined lane, but
all event props stay as ordinary per-event objects just like the baseline.

## Expected reading

If this lane still regresses badly, lazy getter-based `position` materialization is likely the
main reason. If it behaves much better than the combined lane, the earlier failure was at least
partly an interaction effect rather than a clean verdict on lazy positions alone.

## Code Under Test

- `code/event_factory.ts`
- `code/block_parser.ts`
- `code/inline_parser.ts`

## Artifacts

- `artifacts/report.json`
- `artifacts/comparison.json`
- `artifacts/comparison.txt`
- `artifacts/recording.json`
- `artifacts/stress-mixed-16MiB.json`