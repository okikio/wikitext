[![JSR](https://jsr.io/badges/@okikio/wikitext)](https://jsr.io/@okikio/wikitext)
[![JSR Score](https://jsr.io/badges/@okikio/wikitext/score)](https://jsr.io/@okikio/wikitext/score)
[![npm](https://img.shields.io/npm/v/@okikio/wikitext)](https://www.npmjs.com/package/@okikio/wikitext)
[![CI](https://github.com/okikio/wikitext/actions/workflows/ci.yml/badge.svg)](https://github.com/okikio/wikitext/actions/workflows/ci.yml)

# @okikio/wikitext

An event-stream-first wikitext source parser for Deno and npm. It exposes the
raw token and event layers first, then builds higher-level tree utilities on
top of those layers. The AST ("wikist": Wiki Syntax Tree, extending
[unist](https://github.com/syntax-tree/unist)) is part of that public utility
surface, but the event stream remains the fundamental interchange format.

The parser produces a faithful structural model of all documented wikitext
constructs. It does not expand templates or render HTML: it is a source parser.

## Features

- **Event-stream-first architecture**: events are the fundamental output; AST,
  HTML compilation, and filtering are all consumers of the same event stream.
- **Sync pull APIs available today**: `tokens()`, `outlineEvents()`,
  `events()`, and `parse()` expose the current tokenizer, event, and tree
  layers without extra wrapper code.
- **Never throws**: produces a valid tree for any input with error recovery.
- **UTF-16 position semantics**: offsets match `string.charCodeAt(i)` and LSP.
- **unist-compatible**: works with `unist-util-visit` and the unified ecosystem.
- **High performance**: `charCodeAt` scanning, offset-based tokens, single-pass
  with bounded lookahead, JIT-friendly hot loops.
- **Planned next**: `stringify()` and async progressive parsing are still under
  active development.

## Install

```bash
# Deno
deno add jsr:@okikio/wikitext

# Node.js / Bun
npx jsr add @okikio/wikitext
# or
npm install @okikio/wikitext
```

## Current status

The package already ships the foundational public surface:

- `TextSource` and `slice()`
- token types, token validation, and `tokenize()`
- event types, constructors, and type guards
- wikist node interfaces, unions, builders, and type guards
- `blockEvents()` and `inlineEvents()`
- `tokens()`, `outlineEvents()`, `events()`, `parse()`, `parseWithDiagnostics()`, and `parseWithRecovery()`
- `buildTree()`, `buildTreeWithDiagnostics()`, `buildTreeWithRecovery()`, `filter()`, `visit()`, `resolveTreePath()`, `resolveDiagnosticAnchor()`, `locateDiagnostic()`, and `createSession()`

The higher-level orchestration APIs shown in some examples below are still in
progress:

- `stringify()`
- lazy tree-building mode
- `parseChunked()`

## Quick start

```ts
import { parse, stringify, events, outlineEvents } from '@okikio/wikitext';

// Parse wikitext into an AST
const tree = parse('== Heading ==\n\nA paragraph with \'\'\'bold\'\'\' text.');

// Round-trip back to wikitext
const wikitext = stringify(tree);

// Stream events without building a tree
for (const evt of events('== Heading ==\n\nSome text.')) {
  console.log(evt.kind, evt.node_type ?? '');
}

// Block-only events (cheapest structured path)
for (const evt of outlineEvents(largeArticle)) {
  if (evt.kind === 'enter' && evt.node_type === 'heading') {
    toc.push(evt);
  }
}
```

> **Note:** `stringify()` and `parseChunked()` are still not implemented. The
> sync orchestration layer is now available: `tokens()`, `outlineEvents()`,
> `events()`, `parse()`, `parseWithDiagnostics()`, `parseWithRecovery()`, `buildTree()`,
> `buildTreeWithDiagnostics()`, `buildTreeWithRecovery()`, `filter()`, `visit()`, `resolveTreePath()`,
> `resolveDiagnosticAnchor()`, `locateDiagnostic()`, and the basic
> `createSession()` wrapper all ship on top of the existing tokenizer, block
> parser, and inline parser.

You can already use the type system, builder functions, tokenizer, block
parser, and the inline enrichment pass:

```ts
import type { TextSource, WikitextEvent, WikistNode } from '@okikio/wikitext';
import { TokenType, isToken, tokenize, blockEvents, inlineEvents, root, heading, text } from '@okikio/wikitext';

// Tokenize wikitext into a stream of offset-based tokens
for (const tok of tokenize('== Heading ==\nSome text.')) {
  console.log(tok.type, tok.start, tok.end);
  // HEADING_MARKER 0 2
  // WHITESPACE 2 3
  // ...
}

// Stream block-level events from tokenized input
const source = '== Heading ==\n\nA paragraph.';
for (const evt of blockEvents(source, tokenize(source))) {
  console.log(evt.kind, evt.node_type ?? '');
  // enter heading
  // text ...
  // exit heading
  // enter paragraph
  // ...
}

// Enrich block text ranges with inline markup
for (const evt of inlineEvents(source, blockEvents(source, tokenize(source)))) {
  console.log(evt.kind, evt.node_type ?? '');
}

// A plain string satisfies the TextSource interface
const source: TextSource = '== Heading ==\nSome text.';
source.charCodeAt(0); // 61 (code for '=')

// Build a wikist tree programmatically using builder functions
const tree = root([
  heading(2, [text('Heading')]),
]);
tree.type;                    // 'root'
tree.children[0].type;        // 'heading'

// Token type constants are string literals, not opaque numbers
TokenType.HEADING_MARKER;     // 'HEADING_MARKER'
TokenType.TEXT;                // 'TEXT'

// Type guard for runtime validation
isToken({ type: TokenType.TEXT, start: 0, end: 5 }); // true
```

## Architecture

```
Input ──► Tokenizer ──► Event Stream ──► [Consumer]
              │                              │
              │   charCodeAt scanner         ├─► buildTree()     → WikistRoot
              │   Generator<Token>           ├─► compileHtml()   → string
              │                              ├─► filterEvents()  → events
              │                              └─► directConsumer  → callback
              │
              └─► raw token stream (lowest cost)
```

Events, not AST, are the fundamental output. The token stream is exposed for
lowest-cost consumers (search, grep). The event stream adds structure
(enter/exit pairs). The tree builder, HTML compiler, and filter utilities are all
event consumers.

## HTML-like tag recovery

HTML-like and extension-like tags use one simple commitment rule: the parser
only materializes a tag node after the opener reaches `>`.

That gives three distinct outcomes:

- malformed-but-closed openers such as `<ref foo<div>>` still count as real
  tag openers
- openers that never reach `>` stay as plain text and emit an inline recovery
  diagnostic
- openers that do reach `>` stay structurally real even if the matching close
  tag is missing later

Examples:

```text
<ref foo<div>>body</ref>  -> recognized tag pair
<ref name="x">body       -> recognized start tag, recovered missing close
<ref name="x"            -> preserved as text, no tag node committed
```

This is intentionally permissive about malformed attribute territory, but the
hard boundary is still the closing `>` of the opener. That keeps the parser
forgiving without inventing half-built tag nodes that the source never fully
committed to.

## Recovery APIs

The parser always produces a valid result. What the public API lets you choose
is whether you want the forgiving recovered tree or a more conservative tree
that leaves recovery-heavy constructs as plain source text while still telling
you what went wrong.

- `parse(input)` returns the forgiving recovered tree only
- `parseWithDiagnostics(input)` returns `{ tree, diagnostics }`, where `tree`
  strips recovery-created wrapper nodes back to plain text when possible
- `parseWithRecovery(input)` returns `{ tree, recovered, diagnostics }` with
  the more aggressively recovered tree

That gives you a default lane, a conservative diagnostics lane, and an explicit
recovery-aware lane:

```ts
const tree = parse(source);

const diagnostics = parseWithDiagnostics(source);
console.warn(diagnostics.diagnostics);

const result = parseWithRecovery(source);
if (result.recovered) {
  console.warn(result.diagnostics);
}
```

The same split exists on sessions through `session.parseWithDiagnostics()` and
`session.parseWithRecovery()`.

## Performance invariants

The parser's recent performance work follows one rule: remove repeated work
without changing the source ranges the parser reports.

In practical terms, that means these optimizations are allowed:

- coalescing adjacent block-parser text events into larger contiguous ranges
- skipping inline rescans when a merged text group contains no possible inline
  opener
- avoiding temporary arrays or closures in hot parser paths
- using null-prototype object lookups for fixed parser vocabularies where the
  code only needs O(1) membership or value mapping

These optimizations are not allowed to:

- trim real user content that still belongs to a block
- rewrite spacing inside ordinary text ranges
- remove structural boundaries such as table-cell separators
- make block parsing depend on inline meaning

The most important example is the handoff from `blockEvents()` to
`inlineEvents()`. The block parser now tries to emit one larger text range for
contiguous prose instead of many tokenizer-sized fragments. That helps because
the inline parser only cares about accurate source coverage, not the old token
boundaries, so the pipeline avoids splitting text only to merge it again one
stage later.

Another example is the inline plain-text fast path. If a merged text group has
no possible opener such as `[[`, `{{`, `''`, `<`, `&`, `__`, or `~~~`, the
inline parser can return the same text range directly instead of rebuilding
line tables and rescanning bytes that will stay plain text anyway.

The same idea applies to a few fixed parser vocabularies such as token-type
membership and small marker maps. In those spots the code now uses
null-prototype objects plus `Object.hasOwn(...)` instead of `Set` or repeated
mapping switches. That is a targeted performance optimization, not a blanket
style rule. The object acts like a compact lookup table, `Object.create(null)`
removes inherited prototype properties such as `toString`, and
`Object.hasOwn(...)` makes the check explicit: only keys we put in the table
count as matches.

The main cost that still remains is eager `position` construction. Every event
currently carries nested start and end points with line, column, and offset
data. That is useful for downstream tools, but it is not free. The benchmark
work in `mod_bench.ts` isolates that cost so performance discussions can stay
grounded in measured behavior instead of guesswork.

## Tree diagnostics

`parse()` still returns only the tree. That is the smallest, easiest API for
callers that only want document structure.

When a caller also needs recovery details, use `parseWithDiagnostics()` or
`buildTreeWithDiagnostics()`. Those APIs return a more conservative tree plus
a `diagnostics` array.

Each diagnostic carries an `anchor`. Today that anchor is intentionally narrow:
it is a tree-path snapshot to the nearest materialized node around the
recovery point.

```text
root
├─ paragraph        path [0]
│  └─ bold          path [0, 0]
└─ table            path [1]
```

That keeps the AST itself focused on document meaning while still giving
editor, lint, and inspection tools a concrete route from a diagnostic back to
the tree.

If the caller wants that route as a helper instead of rebuilding it manually,
use `resolveDiagnosticAnchor(tree, diagnostic.anchor)` or
`locateDiagnostic(tree, diagnostic)`.

That tree-path anchor is not the future edit-stable anchor API. Session-backed
anchor identity, slot semantics, and cross-edit stability depend on later edit
tracking work, so they are intentionally not public yet.

## Export policy

The package tries to stay utility-first for downstream tooling. In practice,
that means consumer-facing data shapes and helpers are public, while parser
implementation scaffolding stays private until there is a stable reason to
support it.

Public and intended for downstream use:

- source abstractions such as `TextSource`
- token, event, and AST interfaces and unions
- builder functions and type guards
- parser stage entry points such as `tokenize()`, `blockEvents()`, and `inlineEvents()`

Not public yet, and intentionally treated as internal:

- scanner-local context objects
- matcher result records used only inside one parser stage
- low-level recovery helpers whose contracts are still evolving

That boundary matters because utility-first does not mean exporting every local
implementation detail. It means exporting the shapes and helpers that other
tools can build on safely without coupling themselves to one parser pass's
current internals.

### Pipeline modules

| Module | Purpose | Status |
|--------|---------|--------|
| `text_source.ts` | Abstracts the backing text store (string, rope, CRDT) | Published |
| `token.ts` | Token type constants and `Token` interface | Published |
| `events.ts` | Event stream types, constructors, and type guards | Published |
| `ast.ts` | Wikist AST node types, type guards, and builders | Published |
| `tokenizer.ts` | `charCodeAt` generator scanner over `TextSource` | Published |
| `block_parser.ts` | Block-level event emitter | Published |
| `inline_parser.ts` | Inline event enrichment | Published |
| `parse.ts` | Orchestration (tokenizer, block, inline, tree) | Published |
| `tree_builder.ts` | `buildTree(events, { source })` to `WikistRoot` | Published |
| `stringify.ts` | AST to wikitext (round-trip) | Not yet implemented |
| `filter.ts` | Filter/visit for tree and event streams | Published |
| `session.ts` | Stateful `Session` wrapper for repeated sync access | Published |

## API

### Parsing and serialization

| Function | Description |
|----------|-------------|
| `parse(input)` | Parse wikitext into a `WikistRoot` AST. **Available now.** |
| `parseWithDiagnostics(input)` | Parse to `{ tree, diagnostics }` without losing recovery information. **Available now.** |
| `stringify(tree)` | Serialize a wikist tree back to wikitext. _Not yet implemented._ |
| `events(input)` | Full event stream (block + inline). **Available now.** |
| `outlineEvents(input)` | Block-only event stream (no inline parsing). **Available now.** |
| `parseChunked(chunks)` | Progressive completed block nodes (async). _Not yet implemented._ |

### Low-level streams

| Function | Description |
|----------|-------------|
| `tokenize(input)` | Raw token generator stream. **Available now.** |
| `tokens(input)` | Raw token generator alias for the sync public API. **Available now.** |
| `blockEvents(source, tokens)` | Block-level event stream from tokens. **Available now.** |
| `inlineEvents(source, blockEvents)` | Inline event enrichment over block events. **Available now.** |
| `buildTree(events, { source })` | Build AST from an event iterable plus source. **Available now.** |
| `buildTreeWithDiagnostics(events, { source })` | Build `{ tree, diagnostics }` from an event iterable plus source. **Available now.** |

### Tree utilities

| Function | Description |
|----------|-------------|
| `filter(tree, type)` | Get all nodes of a type (recursive). **Available now.** |
| `visit(tree, visitor)` | Pre-order tree walker. **Available now.** |
| `resolveTreePath(tree, path)` | Resolve a root-relative child-index path back to a node. **Available now.** |
| `resolveDiagnosticAnchor(tree, anchor)` | Resolve a diagnostic anchor back to the nearest node. **Available now.** |
| `locateDiagnostic(tree, diagnostic)` | Resolve a diagnostic's `anchor` back to the nearest node. **Available now.** |
| `createSession(source)` | Cached sync wrapper for `outline()`, `events()`, `parse()`, and `parseWithDiagnostics()`. **Available now.** |

### Foundation (available now)

| Export | Module | Description |
|--------|--------|-------------|
| `TextSource` | `text_source.ts` | Interface for backing text stores |
| `slice()` | `text_source.ts` | Resolve offset range to string |
| `TokenType` | `token.ts` | Constant map of all token types |
| `Token` | `token.ts` | Token interface (type + start/end offsets) |
| `isToken()` | `token.ts` | Type guard for Token validation |
| `tokenize()` | `tokenizer.ts` | Generator-based charCodeAt scanner |
| `blockEvents()` | `block_parser.ts` | Block-level event generator from tokens |
| `EnterEvent`, `ExitEvent`, `TextEvent`, `TokenEvent`, `ErrorEvent` | `events.ts` | Concrete event interfaces |
| `WikitextEvent` | `events.ts` | Discriminated union of 5 event kinds |
| `ErrorEventOptions`, `DiagnosticSeverity` | `events.ts` | Diagnostic support types |
| `enterEvent()`, `exitEvent()`, ... | `events.ts` | Event constructors |
| `isEnterEvent()`, `isExitEvent()`, ... | `events.ts` | Event type guards |
| `WikistNode`, `WikistRoot`, `WikistNodeType` | `ast.ts` | Core AST unions and aliases |
| `WikistParent`, `WikistLiteral`, `WikistVoid` | `ast.ts` | Structural AST category unions |
| `root()`, `heading()`, `text()`, ... | `ast.ts` | AST builder functions |
| `isRoot()`, `isHeading()`, `isParent()`, ... | `ast.ts` | AST type guards |

## Contributing

```bash
# Run tests
deno task test

# Run benchmarks
deno task bench

# Check docs
deno doc --lint mod.ts
```

## License

[MIT](./license) © Okiki Ojo
