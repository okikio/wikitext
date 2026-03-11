# Choosing a Parser Result

This page explains the parser-result model the parser is trying to serve at a
high level.

It is intentionally written around the design goal first, not just around the
current wrapper names.

If you only remember one thing from this page, remember this:

the parser is trying to give callers three different kinds of help, and those
kinds of help should stay clearly separated.

1. A fast path when the caller mostly trusts the input.
2. A tolerant path when the caller wants the parser to recover on their behalf.
3. A findings-first path when the caller wants to inspect parser facts first
  and decide later how or whether to materialize them into a tree.

## The simple version

The intended result families look like this.

```text
fast tree
  no diagnostics
  no applied recovery policy
  if the parser is not confident, leave it as text

recovery tree
  diagnostics kept
  recoveries applied on the caller's behalf
  keep malformed-but-committed structure alive when the intent looks clear

findings lane
  diagnostics kept
  replayable findings kept
  possible recoveries listed, not applied
  caller materializes later, or stays at the event level
```

Today's public API only approximates that third family. The current wrappers
are called out near the end of this page, but they should not be the first
thing the reader has to learn.

## Tree 1: fast tree

Use this when performance matters most and you reasonably expect most of the
source to already be valid wikitext.

```ts
const tree = parse(source);
```

What you get:

- the cheapest tree-building lane
- no diagnostics preserved in the result
- no caller-visible recovery policy layered on top

What this tree is trying to do:

- keep clearly valid structure
- stay fast
- avoid extra diagnostic work
- treat uncertain or unknown regions conservatively as text

The important nuance is that "no diagnostics" should not be confused with
"throw on bad input." The parser still has to finish. It just does not spend
extra budget preserving the full problem report for the caller.

This is the lane for callers who are effectively saying:

```text
I mostly trust this input.
Be fast.
If you are not sure, do not be clever.
```

The main magic this tree should avoid:

- no detailed diagnostics list
- no "I repaired this for you" behavior report
- no aggressive inference of malformed committed structure

In practice, the safe default here is usually: if the parser cannot justify the
structure confidently enough for the fast lane, leave the region as text.

## Tree 2: recovery tree

Use this when you want HTML-like flexibility.

This is the lane for callers who are effectively saying:

```text
keep going
recover where the intent looks clear
and tell me what you did on my behalf
```

Today the closest current wrappers are:

```ts
const result = parseWithDiagnostics(source);
// and today, parseWithRecovery(source) is also part of this family
```

What you get:

- diagnostics preserved in the result
- recoveries applied on the caller's behalf
- a tolerant tree that keeps malformed-but-committed structure alive when the
  source still clearly looks like intended markup

This is the closest match to the HTML-like mental model. HTML does not accept
every malformed byte sequence as meaningful, but once the source has clearly
committed to a real construct, it often keeps that structure alive instead of
flattening it immediately.

This tree is the right fit when you want a useful structural result for:

- rendering
- inspection
- editor overlays
- downstream transforms that benefit from best-effort structure

The main magic this tree does perform:

- keeps diagnostics so the caller can see where the source went wrong
- preserves committed malformed structure instead of flattening it immediately
- auto-closes or repairs enough structure to keep the result usable
- records what the parser had to step in and do

The important part is that the parser should be explicit about that help. This
lane is not "silent magic." It is "help me, and tell me where you helped me."

## Result 3: findings lane

Use this when you want the fullest problem picture and you do not want the
parser silently deciding which recoveries should survive in the final tree.

This is the lane for callers who are effectively saying:

```text
show me everything you found
do not apply the recoveries for me
I will decide later which repairs count
and I may want more than one materialization from the same findings
```

What this lane should give:

- diagnostics preserved in the result
- replayable parser findings, not just a one-shot event generator
- possible recoveries listed explicitly
- no recoveries applied on the caller's behalf
- enough information for the caller to choose which repairs to keep,
  discard, or replace later

This is the most ambitious of the three families, and it is also the least
finished part of the current public story.

The main magic this lane should avoid:

- no auto-applied recovery policy in the final tree
- no hidden "the parser already chose for you" step
- no collapsing of the problem into one parser-owned repair worldview
- no one-pass-only shape that forces callers to rerun the parser just to try a
  different materialization policy

The main magic it still needs:

- full diagnostics
- a usable representation of possible recoveries
- a replayable findings object or cached session lane built on the event stream
- explicit materializers for tolerant and conservative tree policies
- a clear distinction between parser facts and candidate repair actions

This is the biggest open design question in the current parser direction.
Unknown syntax is part of that question. If the parser has strong evidence that
something was intended markup, does the findings lane keep a neutral
placeholder, keep source-backed text, or expose a recovery candidate object?
That is the part the design still needs to settle.

The event stream is still the right primitive underneath this lane, but a bare
generator is probably too weak as the public shape. A control-heavy caller may
need to inspect diagnostics, compare candidate repairs, and materialize more
than one final tree without reparsing the same source every time.

## Detailed examples

The easiest way to make the three families concrete is to walk through the same
kind of malformed input more than once.

## Example 1: ordinary valid markup

```text
Paragraph with <ref name="x">note</ref>
```

All three families should agree on the basic structure here.

- fast tree: keep the `reference` node with no diagnostics
- recovery tree: keep the same `reference` node, still no recovery needed
- findings lane: keep the same parser facts, with no recovery list to apply

This is the easy case. Tree policy mostly matters when the source becomes
malformed.

## Example 2: opener is complete, close tag is missing

```text
Paragraph with <ref name="x">note
```

This is the clearest HTML-like recovery case. The source has already made its
intent obvious.

- fast tree: may still choose the cheapest conservative result and leave the
  questionable region as text
- recovery tree: keep the `reference` structure, recover the missing close on
  the caller's behalf, and record that applied repair
- findings lane: preserve the same parser finding, list the missing close and
  possible repair, but do not apply that repair for the caller

The important point is that the recovery tree does not need to pretend the
source was valid. It just keeps the intended structure alive and stays explicit
about the fix.

## Example 3: opener starts but never reaches `>`

```text
Paragraph with <ref name="x"
```

This is the boundary case that most clearly shows why the examples need to stay
aligned with the intended recovery policy.

The earlier version of this page treated this as automatically non-recoverable
because the opener never reached `>`. That was too rigid for the intended
HTML-like recovery story.

If the tolerant lane is meant to recover incomplete but strongly signaled tag
starts, then this input belongs in the recoverable bucket for the recovery tree
and in the possible-recovery bucket for the findings lane.

- fast tree: keep the region as text because this lane should avoid cleverness
- recovery tree: treat this as an incomplete `ref` opener, recover enough
  structure to keep the caller's intent visible, and record that applied repair
- findings lane: report the incomplete opener, list the possible `ref`
  recovery, and let the caller decide whether a later materializer should keep
  a repaired reference node or flatten it back to text

That is still HTML-like in the sense that the parser keeps going, treats the
input as malformed, and tries to preserve the strongest visible structure
instead of throwing the whole region away.

The real lesson is that `>` should not be the only way to explain commitment.
For tolerant recovery, the better question is often: did the source provide
enough evidence of a real construct that recovery is more honest than flattening?

## Example 4: text that only looks a little like markup

```text
2 < 3 and ref name="x"
```

This should stay text across all three families.

- fast tree: text
- recovery tree: text
- findings lane: text, and probably no recovery candidate worth surfacing

This is the opposite side of the boundary. The parser should not turn every
angle bracket plus identifier into a speculative tag.

## Example 5: structure starts clearly, then block syntax breaks later

```text
{|
| Cell
```

This is the block-level version of the same design problem.

- fast tree: keep the cheapest usable result, which may flatten the malformed
  region or keep only the safest obvious structure
- recovery tree: keep the table structure alive, auto-close what is needed at
  end of input, and record the applied repair
- findings lane: preserve the same finding, list the missing table-end
  recovery, and let the caller decide whether a later tree should preserve the
  repaired table or collapse it

That is why this page talks about result families instead of just tag examples.
The same policy question shows up in inline tags, tables, and other committed
structures.

## Where the current public API fits today

The current wrappers do not map perfectly onto the intended three-family model
yet, but this is the rough shape:

- `parse()` is the closest current fast-tree wrapper
- `parseWithDiagnostics()` is the closest current recovery-tree wrapper
- `parseWithRecovery()` stays in that same recovery-tree family today
- `parseStrict()` is still a tree lane, not the final findings-first target
- `events(source, { include_diagnostics: true })` and session caches are the
  closest current low-level building blocks for a future findings lane

So this page should be read as the intended decision model the docs are trying
to clarify, not as a claim that every current wrapper already matches that
model perfectly.

## Which one should most people use?

- Use the fast tree when you mostly trust the input and want the cheapest path.
- Use the recovery tree when you want HTML-like flexibility plus a record of
  what the parser fixed for you.
- Use the findings lane when you want to treat recovery as a later caller
  decision instead of an already-applied parser policy.

If you are still unsure, the recovery-tree family is usually the most useful
default for real tooling because it keeps structure alive and keeps the parser's
help visible instead of hiding it.