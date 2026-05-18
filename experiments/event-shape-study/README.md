# Event Shape Study

This study asks one concrete question: can a different in-memory event representation
make the parser materially faster or smaller without changing parser behavior?

The benefit of keeping this as a study instead of a loose benchmark note is that the
decision rule stays stable. A candidate is not accepted because one local run looked
better. It needs to clear the same timing, memory, and regression bar every time.

Current status:

- `current-baseline` is the control condition and now has its own approach-local code snapshot.
- `shared-props` improves retained memory, but it does not clear the timing bar.
- `lazy-position-shared-props` regresses timing badly and is rejected.
- `planned-flat-eager-event-shape` has now been tested and rejected.

Every approach directory now also carries an approach-local `code/` snapshot and a checked-in
`artifacts/stress-mixed-16MiB.json` file for comparable large-input smoke coverage. The branch now
also has the full drafted experiment toolchain again: one-shot large-input stress, session-oriented
large-input stress, a budgeted `1 GiB` mitata lane, and a preflight inventory that confirms the
study surface is complete before new collection starts.

The newest artifact paths both reject the candidate:

- the refreshed direct snapshot-local comparison reports `-1.49%` target timing, `-3.97%` memory, and no significant target timing wins
- the completed deterministic round-robin check reports `+0.95%` target timing, `-3.97%` memory, and `2/9` significant target timing wins

Those two paths disagree on direction for the aggregate timing median, but they agree on the
important point: this candidate still does not clear the `+5%` acceptance bar and still
regresses retained memory overall.

Important scope note: the current checked-in comparisons are statistically grounded for the
standard study sizes, not for `1 GiB`-class stress inputs. Large-input work now has three separate
study-local collection lanes documented in [methods.md](methods.md): one-shot stress artifacts,
session-oriented stress artifacts, and a budgeted `1 GiB` mitata lane. The current branch only keeps
the lighter `16 MiB` mixed-article smoke artifact per approach checked in so far.

The study uses this decision rule:

- target timing median must improve by at least 5%
- critical workflow timing must not regress by more than 3%
- significance uses bootstrap p-values with Holm adjustment at $\alpha = 0.05$
- raw timing and memory samples must be preserved in machine-readable artifacts

The protocol lives in [protocol.md](protocol.md). The practical collection steps and file
layout live in [methods.md](methods.md). Each approach directory adds its own
approach-specific notes and artifacts. The current checked-in outcome summary lives in
[results.md](results.md). The scenario backlog and rollout order live in
[scenario-roadmap.md](scenario-roadmap.md).