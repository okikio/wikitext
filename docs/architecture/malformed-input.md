# Malformed Input

This note explains the parser's malformed-input model in plain English.

The short version is simple:

the parser never throws, but it also should not treat every malformed span the
same way.

The key question is how much evidence the source gave for a real structure, and
then which caller-facing path should decide what happens next.

One grounding detail matters here too:

when this note says text-backed or plain text, it does not mean the parser must
eagerly copy out a new string value.

In this repo, text usually stays range-first for as long as possible. That
means malformed regions can stay attached to the original source by offsets
instead of being rewritten into fresh strings too early.

That matters because the parser is trying to preserve:

- exact source fidelity
- stable UTF-16 offsets
- lower allocation cost while the parse is still in flight

If you want the fuller explanation for that range-first model, see
[docs/architecture/pipeline.md](./pipeline.md).

## Start with structural evidence, not just recovery

The easiest way to reason about malformed input is to split it into two phases.

```text
1. did the source give enough evidence for a real structure?
2. if yes, which caller-facing path should decide how much of that structure
   survives?
```

That is better than starting with the word recovery, because recovery only
matters after the parser has decided that a real structure or a real recovery
path exists at all.

## Weak evidence stays text-backed

If the source only weakly hints at a construct, the parser should stay
conservative.

Here, text-backed means the parser keeps the region as a text interpretation
rooted in the original source range instead of inventing a stronger structural
node too early.

Example:

```html
2 < 3 and ref name="x"
```

There is not enough real tag structure here to justify a recovered node.

Current tree results:

- `parse()` keeps a text-backed interpretation of that range
- `parseWithDiagnostics()` keeps the same text-backed interpretation and
  reports the problem
- `parseStrictWithDiagnostics()` keeps the same text-backed interpretation and reports the
  problem

## Strong evidence preserves structural intent by default

If the source clearly points at a real construct, the default tree family
should usually preserve that structure and attach diagnostics instead of
flattening it immediately.

Example:

```html
Paragraph with <ref name="x">note
```

The opener did reach `>`, so the parser now has a committed structural finding.

Current tree results:

- `parse()` may keep a `reference` node without returning diagnostics
- `parseWithDiagnostics()` keeps the same default `reference` node and returns
  diagnostics
- `parseWithRecovery()` keeps that same tree and adds a recovery summary
- `parseStrictWithDiagnostics()` may collapse the same region back to text while keeping the
  same diagnostics

That is the main HTML-like part of the design.

## Boundary cases are policy questions

Some malformed inputs sit right on the border between text and recoverable
structure.

Example:

```html
Paragraph with <ref name="x"
```

This is the kind of case the docs should not freeze too early into one
universal answer.

If the default lane is meant to be strongly HTML-like and preserve incomplete
but obvious tag starts, then:

- `parse()` can still keep a text-backed range when the evidence is too weak
- `parseWithDiagnostics()` can recover an incomplete `ref` opener and report
  that repair when the project decides the evidence is strong enough
- `parseStrictWithDiagnostics()` can keep the diagnostics while choosing a more conservative
  final tree

If the project later decides that an opener must reach `>` before the default
lane may keep it structurally real, that is still a valid policy. The
important point is that this is a path-policy decision, not something the docs
should accidentally present as an unquestionable parser fact.

That is also why range-first text matters here. A text-backed interpretation is
not a dead end. The parser can keep the exact source range intact now, attach a
diagnostic to it, and still let a later materializer or caller decide whether
that same span should stay text or become a repaired structure.

## The current tree lanes and the planned `analyze()` lane

The docs should not talk as if the third option is another tree.

The event stream and diagnostics are already the lower-level facts. The third
path should be `analyze()`: a replayable findings layer that can later be
materialized into one tree policy or another.

There is also one more possible layer after that: a caller-owned policy lane
built on top of those same findings. That is more exploratory, because it
would freeze more of the recovery model.

### Default tree family

```ts
parse(source)
parseWithDiagnostics(source)
parseWithRecovery(source)
```

- applies the parser's default recovery behavior when the source gave strong
  enough structural evidence
- keeps good defaults by default
- optionally preserves diagnostics, depending on which wrapper you call
- still never throws

The split inside that family is narrow:

- `parse()` gives the cheapest default tree
- `parseWithDiagnostics()` gives that same tree plus diagnostics
- `parseWithRecovery()` gives that same tree plus diagnostics and a `recovered`
  summary boolean

### Conservative tree

```ts
parseStrictWithDiagnostics(source)
```

- diagnostics preserved
- no applied recovery in the final tree
- more malformed committed regions collapsed back to source-backed text

Again, source-backed text means the final tree prefers a text node that still
points back to the original source span instead of preserving a more tolerant
repaired wrapper.

### `analyze()` findings lane

```ts
analyze(source)
```

- diagnostics preserved
- event-level findings preserved in a replayable form
- recovery data exposed without applying it on the caller's behalf
- final materialization deferred to an explicit later step

That is more diagnostics-first than `parseStrictWithDiagnostics()`. `parseStrictWithDiagnostics()` still
chooses one conservative tree policy for the caller.

### Policy lane

```ts
const findings = analyze(source, { recovery: true });

materialize(findings, {
  policy: 'custom',
  resolve_recovery(recovery) {
    return recovery.node_type === 'reference'
      ? 'keep-structural'
      : 'collapse-to-text';
  },
});
```

- starts from the same `analyze()` findings lane
- lets the caller choose some recoveries itself
- still produces a final tree through a later materialization step

That is not the same as inventing a fourth parser truth. It is a more advanced
consumer policy layer.

## What the parser is and is not doing on the caller's behalf

This is where the docs have been too fuzzy in the past.

The parser always does some continuation work internally. It has to, otherwise
it could not keep the event stream well-formed or uphold the never-throw
contract.

So the real caller choice is not this:

```text
parser continuation vs no parser continuation
```

The real caller choice is closer to this:

```text
do I want the default tree family, the conservative tree, or analyze() first?
and if I want a tree, do I also want diagnostics preserved?
```

That is why `parse()` is cheap, but it is not a no-parser-help-at-all mode.

It is also why flatten back to text should be read carefully in this repo.
Usually that means prefer the original source span as text material rather than
throw away structural knowledge and allocate a brand new replacement string.

## The still-open public shape for `analyze()`

There is one more possibility that the current docs should name explicitly.

It is not fully a public lane yet, but it is the next important design
question:

```text
diagnostics and recovery data are exposed
but the caller chooses the final materialization later
```

That would be more diagnostics-first than `parseStrictWithDiagnostics()`. It would expose the
parser's findings without forcing either the default recovered tree or the
conservative tree as the final answer.

The practical shape should probably be a findings utility or cached session
lane, not a bare generator alone.

A one-pass event generator is still a useful primitive, but it is weak as the
whole public answer for control-heavy callers because they may need to:

- inspect diagnostics
- compare recoveries
- materialize more than one tree policy from the same parse
- keep findings around in a session or streaming workflow

That is likely the right future home for the most control-heavy use cases.

For now, the closest current tools are:

- `events(source, { diagnostics: true })` for low-level event facts
  today
- `createSession(source).events({ diagnostics: true })` when replay and
  caching matter
- `parseStrictWithDiagnostics(source)` for the conservative tree lane today

## Why this is closer to HTML than to Markdown

Many Markdown parsers can say, if we cannot prove it, keep it as text, and
still feel natural.

Wikitext often needs a more forgiving default. If a user clearly started a real
tag, table, or similar construct and only later broke the syntax, flattening it
immediately can hide useful structural intent.

That is why the default tree family here stays closer to HTML-like tolerant
parsing:

- do not guess too early
- do not commit too early
- but once the source clearly committed, preserve that intent unless the caller
  asks for the conservative tree instead