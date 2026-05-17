# Planned Flat Eager Event Shape

## Hypothesis

The next candidate should attack event object layout without adding lazy getters or extra
prototype work. A flatter eager shape may reduce object overhead while keeping property
access straightforward for the JIT and for downstream consumers.

## Methodology

This candidate keeps all changes inside the approach-local `code/` snapshot. It adds a
local `event_factory.ts` with eager point-based constructors and rewires hot block and
inline emission sites to build event objects from start and end points directly.

The study recorded two artifact paths with the standard settings of 10 timing runs and 5
memory repeats:

- a direct snapshot-local comparison against `current-baseline`
- a deterministic round-robin schedule under `../cross-candidate-runs/2026-05-17-baseline-vs-flat-eager-round-robin-02/`

## Observations

The direct snapshot-local comparison rejects the candidate:

- target timing median: `-1.49%`
- memory median: `-3.97%`
- worst critical timing: `-3.55%`
- significant timing wins: `0/9`

The deterministic round-robin check is directionally better on timing, but it still fails
the acceptance rule:

- target timing median: `+0.95%`
- memory median: `-3.97%`
- worst critical timing: `-1.46%`
- significant timing wins: `2/9`

The best directional movement still appears in event-access cases, but the overall target
median stays below the required `+5%` threshold and the retained-memory result moves in the
wrong direction. The worst critical case in the refreshed direct comparison is
`session.parse() warm: same-size mixed (~8 KB)` at `-3.55%`, although it is not significant
after Holm adjustment.

## Conclusion

Reject this candidate. Eager point-based construction is not enough on its own to produce a
clear practical win under the study rule.

## Code Under Test

- `code/event_factory.ts`
- `code/block_parser.ts`
- `code/inline_parser.ts`
- `code/event_shape_bench.ts`
- `code/event_shape_memory.ts`

## Artifacts

- `artifacts/report.json`
- `artifacts/comparison.json`
- `artifacts/comparison.txt`
- `artifacts/recording.json`
- `artifacts/commands.txt`
- `artifacts/stress-mixed-16MiB.json`
- `../cross-candidate-runs/2026-05-17-baseline-vs-flat-eager-round-robin-02/schedule.json`
- `../cross-candidate-runs/2026-05-17-baseline-vs-flat-eager-round-robin-02/comparisons/round-01--current-baseline--vs--planned-flat-eager-event-shape.txt`