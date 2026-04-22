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
```

That surface is already more honest than the older docs, but it still mixes two
different questions:

1. do you want diagnostics?
2. how should malformed regions be materialized?

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

## Lane 3: concrete `analyze()` proposal

There is one stronger diagnostics-first lane that the public API does not fully
offer yet.

```text
diagnostics and recovery data are exposed
but final materialization is delayed or caller-owned
```

That would go beyond `parseStrictWithDiagnostics()`. `parseStrictWithDiagnostics()` still chooses a final tree
policy for the caller. A true `analyze()` lane would expose parser findings
first and let later tools decide which repairs to apply.

That kind of lane is especially compatible with a range-first design because it
lets the parser preserve diagnostics and source spans now, then defer heavier
materialization choices until a caller actually needs them.

One practical shape could look more like this:

```ts
interface AnalyzeOptions {
  readonly recovery?: boolean;
}

interface ParseRecovery {
  readonly kind:
    | 'missing-close'
    | 'unterminated-opener'
    | 'eof-autoclose'
    | 'mismatched-exit';
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

The important part is the ownership model:

- the parser exposes replayable findings
- the caller chooses whether to materialize them at all
- if the caller does materialize them, the tree policy is explicit

That is why a plain one-shot generator is probably not enough as the whole
public lane. The event stream should stay the core primitive, but many callers
will need to inspect diagnostics and materialize more than once without
rerunning the parse.

The main design bet is that findings should stay narrow and factual. A useful
first public version should probably include:

- replayable events
- diagnostics
- a small, parser-owned recovery vocabulary

It should not start by exposing a broad plugin or callback system.

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

The likely order is:

1. make the `analyze()` lane real
2. make the package-owned materializers explicit
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