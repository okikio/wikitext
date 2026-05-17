# Current Results

This file is the compact ledger for the study. It is the quickest way to see what the
checked-in artifacts currently support.

| Approach | Target timing median | Memory median | Worst critical timing | Decision |
|---|---:|---:|---:|---|
| `current-baseline` | control | control | control | keep as baseline |
| `shared-props` | +0.81% | +4.02% | -0.24% | reject |
| `lazy-position-shared-props` | -107.05% | -0.08% | -149.81% | reject |
| `planned-flat-eager-event-shape` | -1.49% | -3.97% | -3.55% | reject |

Interpretation:

- `shared-props` gives a real memory improvement, but the median target timing win is too small to clear the 5% acceptance bar.
- `lazy-position-shared-props` fails hard on timing and is useful mainly as a negative result.
- `planned-flat-eager-event-shape` keeps all changes inside its approach-local snapshot, but the refreshed direct comparison still lands below the timing bar and regresses retained memory.
- the deterministic round-robin check for `planned-flat-eager-event-shape` shifts the target timing median to `+0.95%` with `2/9` significant target wins, but it still misses the acceptance bar and keeps the same memory regression.

Large-input smoke coverage:

- `current-baseline/artifacts/stress-mixed-16MiB.json`
- `shared-props/artifacts/stress-mixed-16MiB.json`
- `lazy-position-shared-props/artifacts/stress-mixed-16MiB.json`
- `planned-flat-eager-event-shape/artifacts/stress-mixed-16MiB.json`

Primary artifacts:

- [current-baseline/artifacts/report.json](current-baseline/artifacts/report.json)
- [shared-props/artifacts/comparison.txt](shared-props/artifacts/comparison.txt)
- [lazy-position-shared-props/artifacts/comparison.txt](lazy-position-shared-props/artifacts/comparison.txt)
- [planned-flat-eager-event-shape/artifacts/comparison.txt](planned-flat-eager-event-shape/artifacts/comparison.txt)
- [cross-candidate-runs/2026-05-17-baseline-vs-flat-eager-round-robin-02/comparisons/round-01--current-baseline--vs--planned-flat-eager-event-shape.txt](cross-candidate-runs/2026-05-17-baseline-vs-flat-eager-round-robin-02/comparisons/round-01--current-baseline--vs--planned-flat-eager-event-shape.txt)