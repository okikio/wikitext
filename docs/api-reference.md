# API Reference

This page is the compact reference index for the currently shipped public API.

If you are new to the package, start with [readme.md](../readme.md) first.
That page explains what the parser is for, how to install it, and which output
shape to choose.

The reference below assumes the same core model as the architecture docs:
parser outputs are range-first, source-backed where practical, and grounded in
UTF-16 offsets.

This page is for lookup, not for the full design explanation.

- for install and first use, go to [readme.md](../readme.md)
- for task-focused snippets, go to [examples.md](./examples.md)
- for parser trade-offs, malformed-input behavior, and tree-policy reasoning,
  go to [architecture/README.md](./architecture/README.md)

## Pipeline modules

| Module | Purpose | Status |
|--------|---------|--------|
| `text_source.ts` | Abstracts the backing text store (string, rope, CRDT) while preserving UTF-16 source access | Published |
| `token.ts` | Token type constants and `Token` interface | Published |
| `events.ts` | Event stream types, constructors, type guards, and diagnostics | Published |
| `ast.ts` | Wikist AST node types, type guards, and builders | Published |
| `tokenizer.ts` | `charCodeAt` generator scanner over `TextSource`, producing offset-based tokens | Published |
| `block_parser.ts` | Block-level event emitter over source-backed token and text ranges | Published |
| `inline_parser.ts` | Inline event enrichment over source-backed text ranges | Published |
| `parse.ts` | Orchestration (tokenizer, block, inline, tree) | Published |
| `tree_builder.ts` | `buildTree(events, { source })` to `WikistRoot`, preserving source-backed positions | Published |
| `stringify.ts` | AST to wikitext (round-trip) | Not yet implemented |
| `filter.ts` | Filter and visit utilities for trees and event streams | Published |
| `session.ts` | Stateful `Session` wrapper for repeated sync access | Published |

## Parsing and serialization

| Function | Description |
|----------|-------------|
| `parse(input)` | Parse wikitext into a `WikistRoot` AST using the cheapest default tree lane. |
| `parseWithDiagnostics(input)` | Parse to `{ tree, diagnostics }` with the default tolerant materialization and preserved diagnostics. |
| `parseWithRecovery(input)` | Parse to `{ tree, diagnostics, recovered }` with the same default tree as `parseWithDiagnostics()` plus an explicit recovery summary. |
| `parseStrictWithDiagnostics(input)` | Parse to `{ tree, diagnostics }` with the conservative source-strict materialization. |
| `analyze(input, options?)` | Analyze source into replayable findings `{ source, events, diagnostics, recovery? }` without materializing a tree. |
| `materialize(findings, options?)` | Build a tree from previously analyzed findings under the requested `TreeMaterializationPolicy`. |
| `stringify(tree)` | Serialize a wikist tree back to wikitext. Not yet implemented. |
| `events(input)` | Full event stream (block + inline), with source-backed text ranges and optional diagnostics. |
| `outlineEvents(input)` | Block-only event stream over the same source-backed structure. |
| `parseChunked(chunks)` | Progressive completed block nodes. Not yet implemented. |

## Low-level streams and tree building

| Function | Description |
|----------|-------------|
| `tokenize(input)` | Raw token generator stream with offset-based token spans. |
| `tokens(input)` | Raw token generator alias for the sync public API. |
| `blockEvents(source, tokens)` | Block-level event stream from tokens. |
| `inlineEvents(source, blockEvents)` | Inline event enrichment over block events, preserving source-backed text ranges where possible. |
| `buildTree(events, { source })` | Build AST from an event iterable plus source. |
| `buildTreeWithDiagnostics(events, { source })` | Build `{ tree, diagnostics }` with the default HTML-like materialization. |
| `buildTreeStrict(events, { source })` | Build `{ tree, diagnostics }` with the conservative source-strict materialization. |
| `buildTreeWithRecovery(events, { source })` | Build `{ tree, diagnostics, recovered }` with the default tree plus an explicit recovery summary. |

## Tree utilities

| Function | Description |
|----------|-------------|
| `filter(tree, type)` | Get all nodes of a type recursively. |
| `visit(tree, visitor)` | Pre-order tree walker. |
| `resolveTreePath(tree, path)` | Resolve a root-relative child-index path back to a node. |
| `resolveDiagnosticAnchor(tree, anchor)` | Resolve a diagnostic anchor back to the nearest node in one materialized tree. |
| `locateDiagnostic(tree, diagnostic)` | Resolve a diagnostic's anchor back to the nearest node while the diagnostic's source span stays authoritative. |
| `createSession(source)` | Cached sync wrapper for repeated access to one source input. |

## Foundation exports

| Export | Module | Description |
|--------|--------|-------------|
| `TextSource` | `text_source.ts` | Interface for backing text stores with UTF-16 source access. |
| `slice()` | `text_source.ts` | Resolve an offset range to a string when a caller needs materialized text. |
| `TokenType` | `token.ts` | Constant map of all token types. |
| `Token` | `token.ts` | Token interface with type plus UTF-16 start and end offsets. |
| `isToken()` | `token.ts` | Type guard for token validation. |
| `tokenize()` | `tokenizer.ts` | Generator-based `charCodeAt` scanner. |
| `blockEvents()` | `block_parser.ts` | Block-level event generator from tokens. |
| `EnterEvent`, `ExitEvent`, `TextEvent`, `TokenEvent`, `ErrorEvent` | `events.ts` | Concrete event interfaces, including source-backed text and diagnostic events. |
| `WikitextEvent` | `events.ts` | Discriminated union of event kinds. |
| `ErrorEventOptions`, `DiagnosticSeverity` | `events.ts` | Diagnostic support types. |
| `enterEvent()`, `exitEvent()`, ... | `events.ts` | Event constructors. |
| `isEnterEvent()`, `isExitEvent()`, ... | `events.ts` | Event type guards. |
| `WikistNode`, `WikistRoot`, `WikistNodeType` | `ast.ts` | Core AST unions and aliases. |
| `WikistParent`, `WikistLiteral`, `WikistVoid` | `ast.ts` | Structural AST category unions. |
| `root()`, `heading()`, `text()`, ... | `ast.ts` | AST builder functions. |
| `isRoot()`, `isHeading()`, `isParent()`, ... | `ast.ts` | AST type guards. |