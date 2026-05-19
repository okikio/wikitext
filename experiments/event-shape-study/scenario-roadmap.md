# Scenario Roadmap

This roadmap names the study lanes that are real on this branch, the ones that are only
partially archived, and the highest-value work still missing from the original event-shape plan.

## Current branch surface

The branch supports four runnable study layers today:

- the standard snapshot-local comparison flow in [methods.md](methods.md)
- the deterministic round-robin check in [methods.md](methods.md)
- the one-shot large-input stress collector and matrix runner in [methods.md](methods.md)
- the structural preflight inventory in [methods.md](methods.md)

The checked-in large-input archive is intentionally narrow. Each approach keeps one comparable
`16 MiB` `mixed-article` smoke artifact so the archive path stays proven without turning the repo
into a dump of heavyweight stress output.

## Standard comparison status

The standard acceptance study is complete for the five checked-in approaches:

- `current-baseline`
- `shared-props`
- `lazy-position`
- `lazy-position-shared-props`
- `planned-flat-eager-event-shape`

Those runs are enough to say the current candidates do not clear the acceptance bar documented in
[protocol.md](protocol.md).

## Large-input archive status

The one-shot large-input lane is implemented, but the archive is only partially filled:

- `16 MiB` `mixed-article` smoke artifacts exist for all five approaches
- the broader one-shot matrix can now be rerun on demand instead of being described only in prose
- session-oriented large-input tooling is not present on this branch
- budgeted mitata large-input tooling is not present on this branch

That means the branch is now internally consistent, but it is still not the final archive shape
from the longer study draft.

## Highest-value remaining work

The original event-shape plan now has the missing lazy-position-only verdict filled in, and that
result is a clear rejection. The highest-value remaining work is now archive completion rather than
another first-order event-shape hypothesis.

If the goal is to finish the study cleanly, the next work should happen in this order:

1. Fill the non-pathological `16 MiB` one-shot matrix for the five checked-in approaches.
2. Decide whether session and mitata lanes belong on this branch as runnable tooling or only in a later follow-up branch.
3. If lazy positions are revisited at all, test a materially different layout that avoids getter-based per-event memoization.