# Parser Contracts

These are the rules every parser API path needs to preserve.

If a future optimization is faster but breaks one of these contracts, that is a
behavior change, not a harmless refactor.

## Why this matters

This repo exposes several views of the same source:

- tokens
- block-only events
- full events
- tree materializations
- later session and streaming views

Those outputs are only useful together if they keep telling the same story.

That shared story is range-first. The parser should preserve the original
source spans and UTF-16 offsets consistently enough that callers can move
between tokens, events, diagnostics, and trees without losing their bearings.

## Contract 1: event well-formedness

Every `enter(X)` must have a matching `exit(X)`.

In plain English, the event stream has to nest like balanced parentheses.

That matters because tree builders, stream consumers, and direct event walkers
all rely on the same stack discipline.

## Contract 2: UTF-16 offsets are authoritative

`position.offset` uses UTF-16 code unit indexing.

That matches:

- `string.charCodeAt(i)`
- `string.slice(start, end)`
- the Language Server Protocol's required UTF-16 compatibility path

When a caller needs exact source fidelity, offsets and source slices win over
derived convenience fields.

That also means text-like data should stay source-backed for as long as
possible. A later tree node, event, or diagnostic may expose a convenient text
view, but the authoritative grounding is still the original source range.

## Contract 3: never throw

The parser must produce a usable result for any input.

That does not mean every malformed region becomes a clean structure.
It means malformed input should become:

- text when the source never committed to structure
- tolerant structure plus diagnostics when the source did commit
- or a more conservative tree when the caller asks for it

But the parser itself does not get to crash.

The never-throw contract does not authorize silent rewriting of the source. It
authorizes continuation while keeping malformed regions attached to either a
source-backed text interpretation or a clearly signaled structural finding.

## Contract 4: determinism

The same input and the same config must produce the same output.

That includes:

- token order
- event nesting
- diagnostics
- tree shape for a given materialization policy

Determinism is what makes corpus regression testing and later incremental work
trustworthy.

## Contract 5: cross-mode block consistency

The default structural story must stay aligned across the main parser views.

```text
outlineEvents()
  == block structure from events()
  == block structure from parse()
```

This matters because `outlineEvents()` is meant to be the cheap structural
overlay. A caller should be able to use it first, then pay for more detail
later, without discovering that the parser changed its mind about which blocks
exist.

`parseStrictWithDiagnostics()` is the one intentional exception. It may collapse a malformed
committed region back to text, so it is allowed to diverge from that default
overlay.

Even there, "back to text" should still mean back to a source-backed text span,
not an invented replacement string.

## Contract 6: commitment points are real boundaries

A suspicious opener is not enough to create structure.

The parser should commit structure only when the source crosses the relevant
recognition boundary.

The clearest current example is HTML-like and extension-like tags:

```text
before `>`  -> keep text-backed interpretation
after `>`   -> opener is structurally real
```

That is why these two cases behave differently:

```text
<ref name="x"
  -> source-backed text in the most conservative interpretation

<ref name="x">body
  -> committed structure in the default tolerant lane
```

Boundary cases may still be policy questions for more HTML-like recovery. The
contract here is narrower: the parser should use real recognition boundaries
instead of inventing structure from weak evidence.

## Contract 7: diagnostics are factual parser findings

Diagnostics should describe what the parser found and what went wrong.

They should not silently pretend that one recovery materialization is the only
possible meaning of malformed input.

That is why the repo increasingly treats diagnostics and final tree shape as
separate concerns.

## What callers can trust after malformed input

These are the practical trust rules.

1. Offsets and source slices stay authoritative.
2. The default tolerant lane keeps the main structural overlay stable.
3. `parseWithDiagnostics()` keeps the same default tolerant tree as `parse()`.
4. `parseStrictWithDiagnostics()` is intentionally more conservative and may collapse a
   committed malformed region back to text.
5. If a construct never reaches its commitment point, it stays text-backed in
   every current tree lane.
6. Diagnostic anchors are tree-local today. They resolve against one final tree
   and do not yet promise edit-stable identity across later session changes.

In all of those cases, "text-backed" means rooted in the original source span,
not eagerly copied into fresh replacement strings.