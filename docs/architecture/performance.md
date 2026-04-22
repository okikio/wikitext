# Performance Model

The parser's performance work follows one rule:

remove repeated work without changing the source ranges the parser reports.

That wording is deliberate. In this repo, source ranges are not an incidental
detail. They are the main way the parser preserves exact source fidelity while
still avoiding unnecessary string allocation.

## What kinds of changes are valid

These are the kinds of optimizations that fit the architecture.

- coalescing adjacent block-parser text events into larger contiguous ranges
- skipping inline rescans when a merged text group contains no possible inline
  opener
- avoiding temporary arrays or closures in hot parser paths
- using compact lookup tables for fixed parser vocabularies where repeated
  membership checks matter

These optimizations all fit the same pattern: do less repeated work while still
pointing at the same original text.

## What kinds of changes are not valid

An optimization is not acceptable if it:

- trims real user content that still belongs to a block
- rewrites spacing inside ordinary text ranges
- removes structural boundaries such as table-cell separators
- makes block parsing depend on inline meaning

The parser can merge ranges and skip redundant work. It cannot change what part
of the source those ranges actually mean.

It also should not eagerly replace range-first data with copied strings unless a
consumer-facing need clearly justifies the cost.

## The main current handoff optimization

The most important recent example is the handoff from `blockEvents()` to
`inlineEvents()`.

The useful change is:

```text
old shape
  many neighboring text fragments
  -> inline parser merges them again

new shape
  one larger contiguous prose range
  -> inline parser scans once
```

That saves work because the inline parser only needs accurate source coverage.
It does not need old tokenizer-sized boundaries if they no longer carry useful
meaning.

That is a good example of the repo's performance philosophy. The parser does
not get faster by knowing less about the source. It gets faster by carrying the
same source meaning with fewer duplicated objects and fewer duplicate scans.

## Why eager positions still matter

The parser still pays a real cost for eagerly materialized positions.

Each event currently carries nested start and end points with:

- line
- column
- offset

That is valuable for tooling, but it is also a meaningful allocation and
computation cost. That is why benchmark work should keep isolating how much of
the total time comes from:

- event creation
- position calculation
- nested position-object allocation

The same kind of scrutiny should apply to eager string materialization. If a
hot path starts producing copied text eagerly where ranges used to be enough,
that is a real performance regression candidate.

## What this means for future optimization

If a proposed optimization does not preserve source fidelity and structural
contracts, it is the wrong optimization.

If it does preserve them, then the next question is simple:

```text
does this remove repeated work on real inputs?
```

That is the bar the performance work should keep using.