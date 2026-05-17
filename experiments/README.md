# Experiments

This directory is the checked-in record of performance and representation experiments.
It exists so the repo keeps the paper trail next to the code instead of scattering
methods, results, and conclusions across chat logs or temporary files.

Each study keeps the same minimum set of material:

- a study-level README that explains the problem, the decision rule, and the current status
- a protocol document that explains how to rerun the study deterministically
- one subdirectory per approach or control condition
- machine-readable artifacts under each approach's `artifacts/` directory
- plain-English notes that explain the hypothesis, method, observations, and conclusion

The current study is [event-shape-study/README.md](event-shape-study/README.md).

Use these rules when adding new work here:

1. Record the question before collecting new data.
2. Keep the collection commands deterministic and write them down.
3. Store raw machine-readable artifacts before writing summaries.
4. Separate observations from conclusions so later readers can challenge the interpretation.
5. Leave enough context that another maintainer could rerun the same study without guessing.