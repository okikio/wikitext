# Choosing a Parser Result

This page explains the parser-result model the parser is trying to serve at a
high level.

It is intentionally written around the design goal first, not just around the
current wrapper names.

If you only remember one thing from this page, remember this:

the parser is trying to give callers three main kinds of help, plus one more
exploratory policy layer, and those should stay clearly separated.

1. A default tree family for callers who want a usable tree immediately and
   want recovery applied by default.
2. A conservative tree path for callers who want a tree immediately but do not
   want that applied recovery to survive in the final tree.
3. A findings-first `analyze()` path for callers who want parser facts first
   and want to decide later how to materialize them.
4. A policy path, still exploratory, where the caller wants to make some of
   those later materialization decisions itself.

The first three paths are the core story. The fourth path is worth exploring,
but it should not be treated as equally settled yet.

## The simple version

The intended result families look like this.

```text
default tree family
  diagnostics optional
  default recovery already applied
  if the parser is not confident, leave it as text

conservative tree
  diagnostics kept
  no applied recovery in the final tree
  collapse malformed committed regions back to text when needed

analyze() findings lane
  diagnostics kept
  replayable findings kept
  recovery data listed, not applied
  caller materializes later, or stays at the event level

policy lane
  starts from the same analyze() findings lane
  caller chooses some recovery outcomes explicitly
  still materializes through a tree policy step later
```

Today's public API already exposes the first two tree-first paths, and it does
not fully expose the third yet. The current wrappers are called out near the
end of this page, but they should not be the first thing the reader has to
learn.

## Path 1: default tree family

Use this when you want a usable tree immediately and want good defaults by
default.

What you get:

- the cheapest tree-building path when you call `parse()`
- default recovery applied in the final tree when the source gave strong enough
  structural evidence
- optional diagnostics, depending on which wrapper you call

What this family is trying to do:

- keep clearly valid structure
- stay fast when diagnostics are not needed
- apply the parser's default tolerant recovery rules when the source clearly
  committed to a structure
- treat uncertain or weakly signaled regions conservatively as text

The important nuance is that no diagnostics should not be confused with no
recovery. `parse()` still never throws, and it still keeps the default tolerant
tree shape when the parser has enough evidence to do that honestly.

This family is the path for callers who are effectively saying:

```text
give me the normal tree
keep good defaults
and only make me pay for diagnostics if I ask for them
```

Today that family is split across three wrappers:

```ts
const tree = parse(source);
const withDiagnostics = parseWithDiagnostics(source);
const withSummary = parseWithRecovery(source);
```

- `parse()` gives the default tree with no preserved diagnostics
- `parseWithDiagnostics()` gives that same tree plus diagnostics
- `parseWithRecovery()` gives that same tree plus diagnostics and a `recovered`
  summary boolean

## Path 2: conservative tree

Use this when diagnostics matter and you do not want applied recovery to remain
visible in the final tree.

This is the path for callers who are effectively saying:

```text
keep going
show me the diagnostics
but do not keep the applied recovery in the final tree
```

Today this path is:

```ts
const result = parseStrictWithDiagnostics(source);
```

What you get:

- diagnostics preserved in the result
- a conservative tree that collapses malformed committed regions back to text
  when the source never justified keeping the recovered wrapper in the final
  tree

This path is useful for:

- inspection
- linting
- editor workflows that want to surface the parser's findings without keeping
  every recovered wrapper in the final tree

## Path 3: `analyze()` findings lane

Use this when you want the fullest problem picture and do not want the parser
applying recovery on your behalf in the final tree yet.

This is the path for callers who are effectively saying:

```text
show me everything you found
do not apply the recovery for me yet
I may want more than one materialization from the same parse
```

What this path should give:

- diagnostics preserved in the result
- replayable parser findings, not just a one-shot event generator
- recovery data listed explicitly
- no recovery applied on the caller's behalf
- enough information for the caller to choose which repairs to keep,
  discard, or replace later

The event stream is still the right primitive underneath this path, but a bare
generator is probably too weak as the public shape. A control-heavy caller may
need to inspect diagnostics, compare recoveries, and materialize more than one
final tree without reparsing the same source every time.

One concrete target shape could look like this.

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

function analyze(
  source: TextSource,
  options?: AnalyzeOptions,
): ParseFindings;

function materialize(
  findings: ParseFindings,
  options?: { readonly policy?: TreeMaterializationPolicy },
): ParseOutput;
```

That shape keeps the ownership split clear:

- `analyze()` owns parser facts
- `materialize()` owns tree policy
- the caller decides whether to materialize at all

It also keeps the event-stream-first architecture intact. Trees stay consumers
of parser findings, not the parser's only public truth.

## Path 4: policy lane

Use this only when you need more control than the package-owned default and
conservative materializers can give you.

This path is still exploratory. It is for callers who are effectively saying:

```text
show me the parser's recovery data
I want to accept some of it and reject other parts myself
```

This path should not be a new parser truth. It should start from the same
`analyze()` lane as Path 3.

One concrete exploration could look like this.

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

That is attractive for:

- editor tooling that wants product-specific repair rules
- compatibility layers for different wiki profiles
- lint or migration tools that want a conservative default with a few explicit
  exceptions

But it is also where the API can become brittle too early.

The main risks are:

- freezing the recovery taxonomy before it is mature
- exposing callback timing as if it were a stable parser contract
- turning parser continuation details into user-configurable hooks too soon
- making sessions and incremental reparsing harder to reason about

That is why this path should stay exploratory for now. The likely order is:

1. make the `analyze()` lane real
2. make the default materializers explicit
3. only then decide whether a custom policy lane belongs in the public API

## Detailed examples

The easiest way to make the paths concrete is to walk through the same kind of
malformed input more than once.

## Example 1: ordinary valid markup

```text
Paragraph with <ref name="x">note</ref>
```

All four paths should agree on the basic structure here.

- default tree family: keep the `reference` node
- conservative tree: keep the same `reference` node too, because no recovery is
  needed
- `analyze()` lane: keep the same parser facts, with no recovery list to apply
- policy lane: same as the `analyze()` lane because there is no recovery choice
  to make

## Example 2: opener is complete, close tag is missing

```text
Paragraph with <ref name="x">note
```

This is the clearest HTML-like recovery case. The source has already made its
intent obvious.

- default tree family: keep the `reference` structure in the final tree
- conservative tree: collapse that malformed committed region back to text
- `analyze()` lane: preserve the same parser finding, list the missing close
  and possible repair, but do not apply that repair for the caller
- policy lane: start from that same missing-close repair and let the caller
  choose whether the final tree keeps a structural `reference` node or
  collapses the region back to text

## Example 3: opener starts but never reaches `>`

```text
Paragraph with <ref name="x"
```

This is the boundary case that most clearly shows why the examples need to stay
aligned with the intended commitment policy.

If the project decides the default lane should recover incomplete but strongly
signaled tag starts, then this input belongs in the recoverable bucket for the
default tree family and in the possible-recovery bucket for `analyze()` and the
policy lane.

- default tree family: recover only if the project decides the evidence is
  strong enough, otherwise keep text
- conservative tree: keep the diagnostics but choose the text-backed final tree
- `analyze()` lane: report the incomplete opener, list the possible `ref`
  recovery, and let a later materializer choose how much survives
- policy lane: use the same recovery entry, but let the caller decide whether
  this particular product treats an obvious but incomplete opener as structural
  or purely textual

## Example 4: text that only looks a little like markup

```text
2 < 3 and ref name="x"
```

This should stay text across all paths.

- default tree family: text
- conservative tree: text
- `analyze()` lane: text, and probably no recovery worth surfacing
- policy lane: same as the `analyze()` lane because there should be no
  meaningful structural recovery to override

## Example 5: structure starts clearly, then block syntax breaks later

```text
{|
| Cell
```

This is the block-level version of the same design problem.

- default tree family: keep the table structure alive in the final tree
- conservative tree: collapse that malformed committed structure back to text
- `analyze()` lane: preserve the same finding, list the missing table-end
  recovery, and let a later tree choose whether to preserve the repaired table
- policy lane: let the caller decide whether this table should survive as a
  best-effort structure or collapse back to text in its own workflow

That is why this page talks about paths instead of just tag examples. The same
policy question shows up in inline tags, tables, and other committed
structures.

## Where the current public API fits today

The current wrappers do not map perfectly onto the intended path model yet, but
this is the rough shape:

- `parse()`, `parseWithDiagnostics()`, and `parseWithRecovery()` are the current
  default-tree family wrappers
- `parseStrictWithDiagnostics()` is the current conservative tree wrapper
- `analyze()` is the intended third path, but it is not the final public API yet
- `events(source, { diagnostics: true })` and session caches are the closest
  current low-level building blocks for a future `analyze()` lane

So this page should be read as the intended decision model the docs are trying
to clarify, not as a claim that every current wrapper already matches that
model perfectly.

## Which one should most people use?

- Use the default tree family when you want good defaults and a usable tree now.
- Use the conservative tree when diagnostics matter but you do not want applied
  recovery to survive in the final tree.
- Use the planned `analyze()` lane when you want to treat recovery as a later
  caller decision instead of an already-applied parser policy.
- Treat the policy lane as an advanced follow-on design, not the default next
  step.

If you are still unsure, the default tree family is usually the most useful
starting point for real tooling because it keeps structure alive and only asks
you to pay for more control when you actually need it.