# Parser Architecture Comparison

This note compares the parser families that matter most to this repo and names
the practical lessons worth carrying forward.

The goal is not to pick a winner. The goal is to avoid borrowing the wrong
mental model from the wrong ecosystem.

## The short answer

This repo should stay closest to an event-stream-first parser with explicit
commitment points and tolerant defaults.

That means:

- not AST-first by default
- not pure Markdown-style fallback-to-text
- not a full HTML-spec tree-construction clone
- not a MediaWiki rendering engine hidden inside a source parser

The right shape is a hybrid tuned for wikitext.

## Comparison table

| Family | Typical strengths | Where it breaks for wikitext | Useful lesson |
| --- | --- | --- | --- |
| Compiler parsers such as SWC, Oxc, Babel | Strong contracts, explicit recovery, precise spans, clear grammar ownership | Wikitext has more legacy ambiguity and more malformed-but-still-intended input | Keep commitment points, diagnostics, and offsets explicit |
| Markdown parsers such as cmark, micromark, goldmark, Comrak | Clean block-inline layering, event pipelines, extension discipline, spec or corpus-driven test culture | Markdown often tolerates unknown syntax by flattening it to text more aggressively than wikitext should | Keep layered parsing and corpus discipline, but do not import Markdown's fallback instinct wholesale |
| HTML parsers and html5lib-style conformance suites | Forgiving parsing after commitment, explicit tokenizer states, rich error categories | HTML's insertion modes and DOM rules are too specific to copy directly into wikitext | Use commitment-driven tolerance and error taxonomy ideas |
| MediaWiki core and Parsoid | Real wikitext correctness pressure, extension boundaries, round-trip expectations | Operationally heavy and too tied to full MediaWiki semantics to use as the core architecture model | Treat them as correctness and corpus references |

## Why compiler architecture is only partially transferable

Compiler parsers earn their simplicity from stronger grammars.

JavaScript, Rust, or TypeScript parsers still have ambiguity, but they usually
know the space of valid forms ahead of time. Wikitext has more legacy syntax,
profile-specific behavior, extension-driven constructs, and malformed content
that users still expect to "work well enough."

So the lesson from compiler parsers is not "use recursive descent everywhere"
or "turn the grammar into a formal parser generator input." The lesson is to
be explicit about these boundaries:

- when structure becomes committed
- what counts as a factual parser finding
- what offsets and ranges mean
- which behavior is parser truth versus consumer policy

That matches the repo's diagnostics-first direction.

## Why Markdown architecture is useful but incomplete

Markdown parsers are closer to this repo operationally because they often split
block and inline work and they often support event or token pipelines.

micromark is especially relevant because it treats events as the primary
interchange layer and lets AST builders sit on top. That is already a strong
fit for this repo.

But Markdown has one dangerous influence here: many implementations can safely
say "if we cannot prove this syntax, just keep the text." Wikitext cannot
always do that, because users often write malformed markup that is still
clearly trying to be a table, tag, link, or template.

That is why this repo should keep the pipeline lesson from Markdown, but not
the full malformed-input philosophy.

## Why HTML-style commitment matters more for malformed input

HTML parsing gives a better model for the repo's tolerant default lane.

The useful pattern is:

```text
before commitment   -> keep text-backed interpretation
after commitment    -> preserve structural intent
malformed continue  -> emit diagnostics and keep going
strict consumer     -> optionally collapse back to text later
```

This repo should keep that shape for tags and, where it fits, for other
constructs with meaningful commitment points.

The important part is discipline. A forgiving parser is not a guessing parser.
It still needs explicit rules for when an opener became real.

## Why MediaWiki and Parsoid are the correctness references

MediaWiki core and Parsoid are where the ecosystem has already paid for years
of parser mistakes.

They matter less because their internals are pretty and more because their test
corpora capture:

- real editorial habits
- malformed inputs that still need usable output
- extension interactions
- round-trip expectations
- regression history

This repo should not clone their architecture. It should borrow pressure from
their corpora and use that pressure to validate its own simpler architecture.

## Recommended architecture stance

This is the working recommendation.

### Core parser

- Keep the tokenizer, block parser, and inline parser hand-written.
- Keep events as the primary interchange layer.
- Keep offsets and positions range-first.

### Malformed-input model

- Treat diagnostics as parser facts.
- Treat continuation as internal survivability logic.
- Treat final tree shape as materialization policy.

### Public API philosophy

- Default lane keeps tolerant structure.
- Strict lane stays conservative.
- Recovery summary is optional metadata, not a separate parser truth.

### Extension philosophy

- Prefer primitive-first composition over deep parser plugins.
- Keep extension boundaries explicit, especially for tag-like and parser-
  function-like constructs.

## What to test because of this comparison

Architecture choices only matter if tests make them real.

The most important tests implied by this comparison are:

1. Block structure stays consistent across `outlineEvents()`, `events()`, and
   `parse()` in the default tolerant lane.
2. A construct that never reaches its commitment point stays text-backed in all
   lanes.
3. A construct that did commit may stay structural in the default lane and
   collapse in the strict lane without changing diagnostics.
4. Extension-boundary constructs such as `<ref>` and parser functions stay
   covered by their own reduced corpora instead of leaking into generic tests.
5. Later round-trip work should use Parsoid-style corpus pressure instead of
   synthetic only-happy-path fixtures.

The corresponding corpus plan lives in [docs/corpus-matrix.md](./corpus-matrix.md).