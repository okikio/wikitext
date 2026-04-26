# API Direction

This note explains the current public surface and the likely direction of the
next cleanup.

It is not a promise that the public API will change immediately. It is a way to
write down the target shape clearly enough that the docs, code, and tests can
move toward the same model.

## Why this note exists

The parser docs have been trying to explain three things at once:

- what callers can use today
- what those current wrappers really mean
- where the public surface likely wants to go next

Those are related, but they are not the same question.

This note keeps the future-facing public-surface discussion separate from the
user-facing "which result do I want?" explanation in
[choosing-a-parser-result.md](./choosing-a-parser-result.md).

It also assumes the same range-first base as the rest of the architecture docs:
diagnostics, events, and text-like tree content should stay anchored to source
spans and UTF-16 offsets for as long as possible.

## Current public shape

Today the main wrappers are:

```text
parse()
  -> default tree

parseWithDiagnostics()
  -> default tree + diagnostics

parseWithRecovery()
  -> default tree + diagnostics + recovery summary

parseStrictWithDiagnostics()
  -> conservative tree + diagnostics

analyze()
  -> findings (events + diagnostics + recovery list), no tree

materialize(findings, { policy? })
  -> tree + diagnostics under one materialization policy
```

The tree-first wrappers still mix two questions (diagnostics and
materialization), but `analyze()` + `materialize()` now separate them
cleanly for callers who want that split.

## The direction the surface is moving toward

The cleaner long-term public story is:

```text
diagnostics are one choice
materialization policy is another choice
findings are the replayable bridge between them
```

That makes the API easier to reason about.

Instead of teaching several top-level parser truths, the surface can teach a
smaller set of orthogonal choices:

- tree now, or findings first
- diagnostics off or on
- package-owned or caller-owned materialization policy

## One concrete target shape

One reasonable target would look like this.

```ts
interface ParseOptions {
  readonly diagnostics?: boolean;
  readonly materialization?: 'default-html-like' | 'source-strict';
}

interface ParseOutput {
  readonly tree: WikistRoot;
  readonly diagnostics?: readonly ParseDiagnostic[];
}
```

That does not have to be the final naming. The point is the shape:

- one option controls whether diagnostics are collected
- another option controls the final tree policy

`diagnostics` should be the public boolean name everywhere. It reads like a
caller-facing lane choice instead of an internal implementation switch.

Under that surface, the parser should still keep its range-first behavior.
Changing the API shape should not imply a move toward eagerly copied strings or
away from source-backed text interpretations.

Convenience wrappers could still exist on top of that base surface.

## Lane 3: shipped `analyze()` + `materialize()` API

The diagnostics-first lane is now public:

```text
diagnostics and recovery data are exposed
final materialization is delayed or caller-owned via materialize()
```

That goes beyond `parseStrictWithDiagnostics()`, which still chooses a final
tree policy for the caller. `analyze()` exposes parser findings first, and
`materialize()` is the explicit step that turns those findings into one
tree under a named policy.

The shipped shape looks like this:

```ts
interface AnalyzeOptions {
  readonly recovery?: boolean;
}

interface ParseRecovery {
  readonly kind:
    | 'missing-close'
    | 'unterminated-opener'
    | 'unclosed-table'
    | 'mismatched-exit'
    | 'orphan-exit'
    | 'eof-autoclose';
  readonly code: string;
  readonly position: Position;
  readonly anchor: ParseDiagnosticAnchor;
  readonly node_type?: WikistNodeType;
  readonly policies: readonly TreeMaterializationPolicy[];
}

interface ParseFindings {
  readonly source: TextSource;
  readonly events: readonly WikitextEvent[];
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly recovery?: readonly ParseRecovery[];
}

function analyze(source: TextSource, options?: AnalyzeOptions): ParseFindings;

function materialize(
  findings: ParseFindings,
  options?: { readonly policy?: TreeMaterializationPolicy },
): ParseOutput;
```

The ownership model is explicit:

- the parser exposes replayable findings
- the caller chooses whether to materialize them at all
- if the caller does materialize them, the tree policy is explicit

## Lane 4: exploratory policy proposal

There is one possible lane after that, but it should stay explicitly more
tentative.

```text
the caller starts from parse findings
the caller chooses some recovery outcomes itself
the final tree still comes from a later materialization step
```

One concrete exploration could look like this:

```ts
type RecoveryDecision = 'keep-structural' | 'collapse-to-text';

interface CustomMaterializeOptions {
  readonly policy: 'custom';
  readonly resolve_recovery: (
    recovery: ParseRecovery,
  ) => RecoveryDecision;
}

function materialize(
  findings: ParseFindings,
  options: CustomMaterializeOptions,
): ParseOutput;
```

That would be powerful for editors, migration tools, and profile-specific
compatibility layers, but it also hardens the recovery taxonomy and
callback timing much earlier than the package may want.

That is the core trade-off.

- Lane 3 makes parser facts explicit.
- Lane 4 starts making parser policy negotiable.

Lane 3 is easier to keep stable because it mostly exposes what the parser
already knows. Lane 4 is harder because it starts exposing when and how those
findings are turned into structure.

The likely remaining order is:

1. ~~make the `analyze()` lane real~~ (shipped)
2. ~~make the package-owned materializers explicit~~ (shipped via
   `TreeMaterializationPolicy`)
3. only then decide whether a caller-owned policy lane belongs in public API

That is the kind of thing I meant earlier by an "API proposal doc": a short
design note that describes a possible future public surface before code changes
lock it in.

## What this note is not

This note is not:

- a release plan
- a promise that names or wrappers will change now
- a replacement for the user-facing parser-result docs

It is just a way to make the future public-surface direction legible.