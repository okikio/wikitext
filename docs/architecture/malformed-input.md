# Malformed Input

This note explains the parser's malformed-input model in plain English.

The short version is:

the parser never throws, but it also should not treat every malformed thing the
same way.

The key question is how much evidence the source gave for a real structure, and
then how much repair the chosen tree family should apply.

One grounding detail matters here too:

when this note says "text-backed" or "plain text," it does not mean the parser
must eagerly copy out a new string value.

In this repo, text usually stays range-first for as long as possible. That
means malformed regions can remain attached to the original source by offsets
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
2. if yes, how much of that structure should survive in the final tree?
```

That is better than starting with the word "recovery," because recovery only
matters after the parser has decided that a real structure or a real recovery
candidate exists at all.

## Weak evidence: stay text-backed

If the source only weakly hints at a construct, the parser should stay
conservative.

Here, "text-backed" means the parser keeps the region as a text interpretation
rooted in the original source range instead of inventing a stronger structural
node too early.

Example:

```html
2 < 3 and ref name="x"
```

There is not enough real tag structure here to justify recovery.

Current tree-lane result:

- `parse()` keeps a text-backed interpretation of that range
- `parseWithDiagnostics()` keeps the same text-backed interpretation and
  reports the problem
- `parseStrict()` keeps the same text-backed interpretation and reports the
  problem

## Strong evidence: preserve structural intent by default

If the source clearly points at a real construct, the default tolerant lane
should usually preserve that structure and attach diagnostics instead of
flattening it immediately.

Example:

```html
Paragraph with <ref name="x">note
```

The opener did reach `>`, so the parser now has a committed structural finding.

Current tree-lane result:

- `parse()` may keep a `reference` node without returning diagnostics
- `parseWithDiagnostics()` keeps the default tolerant `reference` node and
  returns diagnostics
- `parseStrict()` may collapse the same region back to text while keeping the
  same diagnostics

That is the main HTML-like part of the design.

## Boundary cases are policy questions

Some malformed inputs sit right on the border between "text" and "recoverable
structure."

Example:

```html
Paragraph with <ref name="x"
```

This is the kind of case the docs should not freeze too early into one
universal answer.

If the tolerant lane is meant to be strongly HTML-like and preserve incomplete
but obvious tag starts, then:

- `parse()` can still keep a text-backed range because the fast lane avoids
  extra magic
- `parseWithDiagnostics()` can recover an incomplete `ref` opener and report
  that repair
- `parseStrict()` can keep the diagnostics while choosing a more conservative
  final tree

If the project later decides that an opener must reach `>` before the tolerant
lane may keep it structurally real, that is still a valid policy. The important
thing is that this is a recovery-policy decision, not something the docs should
accidentally present as an unquestionable parser fact.

That is also why range-first text matters here. A text-backed interpretation is
not a dead end. The parser can keep the exact source range intact now, attach a
diagnostic to it, and still let a later materializer or caller decide whether
that same span should stay text or become a repaired structure.

## The three current caller-facing lanes

### Cheap tree

```ts
parse(source)
```

- cheapest tree lane
- no preserved diagnostics
- still never-throw
- still uses the default tolerant materialization

### Tolerant tree with diagnostics

```ts
parseWithDiagnostics(source)
parseWithRecovery(source)
```

- same default tolerant tree family as `parse()`
- diagnostics preserved
- optional `recovered` summary boolean from `parseWithRecovery()`

### Conservative tree with diagnostics

```ts
parseStrict(source)
```

- diagnostics preserved
- more malformed committed regions collapsed back to source-backed text

Again, "source-backed text" means the final tree prefers a text node that still
points back to the original source span instead of preserving a more tolerant
repaired wrapper.

## What the parser is and is not doing on the caller's behalf

This is where the docs have been too fuzzy in the past.

The parser always does some continuation work internally. It has to, otherwise
it could not keep the event stream well-formed or uphold the never-throw
contract.

So the real caller choice is not:

```text
parser continuation vs no parser continuation
```

The real caller choice is closer to:

```text
do I want diagnostics preserved?
and if so, which final tree policy do I want?
```

That is why `parse()` is cheap, but it is not a "no parser help at all" mode.

It is also why "flatten back to text" should be read carefully in this repo.
Usually that means "prefer the original source span as text material" rather
than "throw away structural knowledge and allocate a brand new replacement
string."

## The still-open fourth lane

There is one more possibility that the current docs should name explicitly.

It is not fully a public lane yet, but it is the next important design
question:

```text
diagnostics and possible recoveries are exposed
but the caller chooses the final materialization later
```

That would be more diagnostics-first than `parseStrict()`. It would expose the
parser's findings without forcing either the default tolerant tree or the
conservative tree as the final answer.

That is likely the right future home for the most control-heavy use cases.

For now, the closest current tools are:

- `events(source, { include_diagnostics: true })` for event-level findings
- `parseStrict(source)` for the conservative tree lane

## Why this is closer to HTML than to Markdown

Many Markdown parsers can say, "if we cannot prove it, keep it as text," and
still feel natural.

Wikitext often needs a more forgiving default. If a user clearly started a real
tag, table, or similar construct and only later broke the syntax, flattening it
immediately can hide useful structural intent.

That is why the default lane here stays closer to HTML-like tolerant parsing:

- do not guess too early
- do not commit too early
- but once the source clearly committed, preserve that intent unless the caller
  asks for a more conservative tree