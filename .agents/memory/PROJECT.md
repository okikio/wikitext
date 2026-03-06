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

Implemented:
- `text_source.ts`: `TextSource` interface + `slice()` helper
- `token.ts`: `TokenType` const-object (40+ types), `Token` interface, `isToken()`
- `events.ts`: `WikitextEvent` union (5 kinds), constructors, type guards
- `ast.ts`: 37 wikist node types, type guards, builder functions

Not yet implemented:
- `tokenizer.ts`: charCodeAt generator-based scanner
- `block_parser.ts`: block-level event emitter
- `inline_parser.ts`: inline event enrichment
- `parse.ts`: orchestration (tokenizer → block → inline → tree)
- `tree_builder.ts`: `buildTree(events) → WikistRoot`
- `stringify.ts`: AST → wikitext (round-trip)
- `filter.ts`: filter/visit for tree and event streams
- `session.ts`: stateful Session wrapper (incremental, streaming)

## Key exports

Available now:
- `TextSource`, `slice()` (text_source.ts)
- `TokenType`, `Token`, `isToken()` (token.ts)
- `WikitextEvent`, `EnterEvent`, `ExitEvent`, ... + constructors + guards (events.ts)
- `WikistNode`, `WikistRoot`, 37 node types + type guards + builders (ast.ts)

Not yet implemented:
- `parse()`, `events()`, `outlineEvents()`, `stringify()`
- `tokens()`, `buildTree()`
- `filter()`, `visit()`

## Architecture

Events, not AST, are the fundamental output. Three streaming modes:
- `outlineEvents(input)`: block-only, no inline parsing
- `events(input)`: full enter/exit/text events
- `parseChunked(chunks)`: progressive completed blocks (async)

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
