# Project Summary

## Outcome

`@okikio/wikitext` is an event-stream-first wikitext source parser for Deno and
npm. It parses wikitext markup into a structured AST ("wikist": Wiki Syntax
Tree, extending unist) while exposing the raw event stream as the fundamental
interchange format.

## Context

- Runtime: Deno v2, TypeScript (strict), ESM
- Published to: JSR and npm
- Flat file layout at root; `mod.ts` re-exports all public APIs
- Source parser only: no template expansion or HTML rendering

## Key modules

- `ast.ts`: wikist node types (26+), type guards, builders
- `events.ts`: `WikitextEvent` union, constructors
- `token.ts`: `Token` interface, `TokenType` enum
- `tokenizer.ts`: charCodeAt generator-based scanner
- `block_parser.ts`: block-level event emitter
- `inline_parser.ts`: inline event enrichment
- `parse.ts`: orchestration (tokenizer → block → inline → tree)
- `tree_builder.ts`: `buildTree(events) → WikistRoot`
- `stringify.ts`: AST → wikitext (round-trip)
- `filter.ts`: filter/visit for tree and event streams

## Key exports

- **Core API**: `parse()`, `events()`, `outlineEvents()`, `stringify()`
- **Low-level**: `tokens()`, `buildTree()`, `slice()`
- **Filtering**: `filter()`, `visit()`, `filterTemplates()`, `filterLinks()`

## Architecture

Events, not AST, are the fundamental output. Three streaming modes:
- `outlineEvents(input)`: block-only, no inline parsing
- `events(input)`: full enter/exit/text events
- `parseChunked(chunks)`: progressive completed blocks (async, Phase 6)

## Parser contracts

1. Event well-formedness (stack discipline)
2. UTF-16 code unit offsets (matching JS string indexing)
3. Never-throw guarantee (valid tree for any input)
4. Determinism (same input + config → same output)

## Constraints

- All public API types must be exported (enforced by `deno doc --lint`).
- No hidden global state; no top-level side effects.
- Keep modules tree-shakeable.
- charCodeAt scanning; offset-based tokens (no value strings).

## Non-goals

- Template expansion or transclusion
- HTML rendering
- MediaWiki behavioral quirk-matching (deferred to "mediawiki" profile)
