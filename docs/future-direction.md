# Future Direction

This note captures the broader direction behind the current parser work.

The parser is the current product focus, but it is not the full long-term
product story. Writing that down matters because parser architecture choices
look different when the parser is understood as a base layer rather than the
final user-facing system.

## What this repo is building now

Right now this repository is building a standards-aligned wikitext source
parser.

Its job is to turn source text into reusable parser primitives:

- tokens
- events
- trees
- diagnostics
- session-oriented access patterns later on

Those primitives need to be good enough for extraction, rendering,
transformation, inspection, and editor-facing tooling.

## What comes next

Two higher-level libraries should sit above the parser once the core surface is
ready enough.

```text
@okikio/wikitext
  ├─► @okikio/wikidoc
  └─► @okikio/wiki-extract
```

### `@okikio/wikidoc`

This layer should focus on document-oriented work built on top of parser
primitives.

That likely includes:

- higher-level document transforms
- structure-aware editing helpers
- richer composition around trees, diagnostics, and sessions
- bridges toward editor and CMS-style workflows

### `@okikio/wiki-extract`

This layer should focus on pulling useful structured information out of parsed
content.

That likely includes:

- template and infobox extraction
- category and link extraction
- reference extraction
- selective structure queries and summaries

The key point is that extraction and document composition should not distort the
parser core. They should consume parser primitives instead.

## Longer-term direction

Longer term, the same primitives may expand into a broader profile-driven
document engine.

That direction is bigger than "a better wikitext parser." It points toward a
system that can support:

- wikitext as the proving ground
- additional markup or rich-text families later
- CMS-style structured blocks
- editor-facing session and incremental workflows
- local-first or collaboration-aware tooling
- LLM-oriented document transforms built on explicit structure rather than raw
  text guessing

The right way to read this is as a direction of travel, not as a promise that
all of those layers belong in this package soon.

## Why this matters to the parser now

This longer horizon changes what "good parser architecture" means.

The parser should optimize for reusable primitives, not just one rendering
pipeline.

That means:

- events need to stay first-class
- diagnostics need to stay factual and reusable
- offsets need to stay authoritative
- extension boundaries need to stay narrow and composable
- session and incremental APIs need to build on the same core primitives

It also means the parser should avoid baking in product-specific behavior that
really belongs one layer up.

## Non-goals for the core parser

The parser core should not silently become:

- a full MediaWiki runtime
- a CMS block model
- an editor framework
- a collaboration engine
- an extraction product

Those may all become consumers or adjacent layers. They should not become the
hot loop.

## Design pressure this adds today

This broader direction puts useful pressure on current decisions.

### Diagnostics versus materialization

Different higher-level consumers need different responses to malformed input.
An extractor, a renderer, and an editor may all want the same parser finding
but a different final representation.

That is why diagnostics should stay parser facts and final tree shape should
stay a materialization choice.

### Primitive-first extension model

If the long-term system grows into multiple products, deep parser hooks become
too expensive too early.

The core should prefer:

- stable tokens, events, and trees
- narrow feature gates
- explicit tag or profile handlers
- downstream enrichment passes

### Profile-driven behavior

The broader engine direction does not require one giant parser that tries to do
everything at once.

It points instead toward profiles layered over shared primitives:

```text
shared parser primitives
  ├─► syntax profile
  ├─► mediawiki-compatible profile
  └─► later document-oriented profiles
```

That keeps the core maintainable while leaving room for stricter or more
product-specific behavior later.

## How to use this note

Use this note when judging parser design trade-offs.

If two parser designs look equally good for today's tests, prefer the one that:

- keeps primitives reusable
- keeps product policy out of the hot path
- keeps future extraction and document tooling possible
- preserves optionality for profile-driven evolution

If a design only makes sense for one consumer and hardens that assumption into
the parser core, it is probably the wrong long-term move.