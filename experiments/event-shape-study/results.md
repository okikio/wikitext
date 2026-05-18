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

Archive completion summary:

| Lane | Scenario set | Implemented | Collected across all four approaches | Current status |
|---|---|---:|---:|---|
| Standard comparison | event-shape timing + retained memory | yes | yes | complete |
| `16 MiB` one-shot stress | ten scenarios | yes | partial | only `mixed-article` is checked in across all four approaches |
| `16 MiB` session stress | ten scenarios | yes | partial | `mixed-article` and `synthetic-article` are checked in across all four approaches |
| `1 GiB` mitata stress | ten scenarios | yes | yes for all non-pathological scenarios | nine normal scenarios are complete across all four approaches; only `pathological-recovery` remains outside the normal archive |
| `1 GiB` one-shot stress | ten scenarios | yes | no | archive not started |
| `1 GiB` session stress | ten scenarios | yes | no | archive not started |
| Pathological limit lane | separate parser-limit study | yes | n/a | treat as limit study, not as a normal missing archive row |

Large-input archive status:

- comparable `16 MiB` mixed-article one-shot smoke artifacts exist for all four approaches
- full one-shot matrix tooling now exists for ten scenario families
- session-stress tooling now exists for the same ten scenario families as the one-shot lane
- budgeted `1 GiB` mitata tooling now exists for the same ten scenario families as the one-shot lane
- the non-pathological `1 GiB` mitata archive is now complete across all four approaches for `plain-paragraphs`, `mixed-article`, `table-heavy`, `template-heavy`, `inline-heavy`, `uri-heavy`, `unicode-heavy`, `synthetic-article`, and `outline-heavy`
- `pathological-recovery` is now clearly a separate parser-limit lane rather than an ordinary large-input benchmark row: baseline was hard-killed at `1 GiB`, baseline `256 MiB` overran a `60s` budget for more than thirty minutes before it was stopped, and a cross-approach `1/2/4 MiB` mitata sweep failed for all four approaches with `RangeError: Maximum call stack size exceeded`
- `16 MiB` session-stress artifacts for `mixed-article` and `synthetic-article` now exist for all four approaches
- the first `16 MiB` session-matrix attempt showed that `pathological-recovery` is not part of the quick lane on this branch: `current-baseline` was still consuming a full CPU core after more than eleven minutes before the run was stopped
- the broader one-shot matrix and the session matrix are still not filled yet on this branch, but the normal `1 GiB` mitata lane is now fully checked in

Primary artifacts:

- [current-baseline/artifacts/report.json](current-baseline/artifacts/report.json)
- [shared-props/artifacts/comparison.txt](shared-props/artifacts/comparison.txt)
- [lazy-position-shared-props/artifacts/comparison.txt](lazy-position-shared-props/artifacts/comparison.txt)
- [planned-flat-eager-event-shape/artifacts/comparison.txt](planned-flat-eager-event-shape/artifacts/comparison.txt)
- [cross-candidate-runs/2026-05-17-baseline-vs-flat-eager-round-robin-02/comparisons/round-01--current-baseline--vs--planned-flat-eager-event-shape.txt](cross-candidate-runs/2026-05-17-baseline-vs-flat-eager-round-robin-02/comparisons/round-01--current-baseline--vs--planned-flat-eager-event-shape.txt)