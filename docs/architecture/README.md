# Architecture Docs

This folder breaks the larger architecture story into smaller documents with
one job each.

If you are new to the repo, start with the parser-result note first. It explains
the user-facing parser outputs before the deeper pipeline details.

This folder is not the package introduction and it is not the symbol lookup
reference.

- for install, first use, and the package overview, use [readme.md](../readme.md)
- for exported names and compact API tables, use
  [api-reference.md](../api-reference.md)
- use this folder when you want the design model and trade-offs

## Start here

- [choosing-a-parser-result.md](./choosing-a-parser-result.md)
  Explains the practical caller question: which parser result should I ask for,
  why, and what trade-off each lane makes, including the planned
  `analyze()` findings-first lane and the still-exploratory policy lane.
- [pipeline.md](./pipeline.md)
  Explains the tokenizer -> block parser -> inline parser -> consumer flow in
  plain English.
- [malformed-input.md](./malformed-input.md)
  Explains commitment points, diagnostics, and why tolerant versus
  conservative tree materialization are separate choices.
- [diagnostics-first.md](./diagnostics-first.md)
  Explains the diagnostics-first model without the full redesign note.
- [api-direction.md](./api-direction.md)
  Explains the likely future public-surface cleanup without turning the main
  parser-result note into an API design memo.
- [diagnostic-anchors.md](./diagnostic-anchors.md)
  Explains how diagnostics point back into the final tree.
- [parser-contracts.md](./parser-contracts.md)
  Lists the invariants that the parser and its consumers rely on.
- [utility-first.md](./utility-first.md)
  Explains why the package exposes primitives instead of leading with hooks.
- [performance.md](./performance.md)
  Explains the performance model and what kinds of optimizations are valid.
- [sessions-and-streaming.md](./sessions-and-streaming.md)
  Explains the session wrapper, cache lanes, stability frontier, and later
  incremental direction.

## Larger reference docs

- [../architecture.md](../architecture.md)
  The long-form reference. Use this if you still want the larger architecture
  story in one place while the split docs are being built out.
- [../diagnostics-first-redesign.md](../diagnostics-first-redesign.md)
  The design note for the diagnostics-first realignment and the remaining open
  design questions.
- [../future-direction.md](../future-direction.md)
  The broader product direction behind the parser work.
- [../parser-architecture-comparison.md](../parser-architecture-comparison.md)
  Why this repo borrows different lessons from compiler, Markdown, HTML, and
  MediaWiki parser families.
- [../corpus-matrix.md](../corpus-matrix.md)
  The upstream corpus plan that should drive future parser tests.

## Why this split exists

The original architecture note does contain the right ideas, but it asks the
reader to absorb too much at once.

That is especially costly around tree materialization. Many readers do not
first want to know about event streams, state snapshots, or incremental edit
mapping. They first want to know which parser result matches their use case.

This folder fixes that by making the user-facing choice legible before the full
internal machinery.

Across these docs, one shared assumption is worth keeping in mind: the parser
is range-first. Text, diagnostics, and many later tree decisions stay anchored
to spans in the original source for as long as possible. That is part of how
the repo preserves source fidelity, UTF-16 offsets, and low-allocation parser
paths at the same time.