[![JSR](https://jsr.io/badges/@okikio/wikitext)](https://jsr.io/@okikio/wikitext)
[![JSR Score](https://jsr.io/badges/@okikio/wikitext/score)](https://jsr.io/@okikio/wikitext/score)
[![npm](https://img.shields.io/npm/v/@okikio/wikitext)](https://www.npmjs.com/package/@okikio/wikitext)
[![CI](https://github.com/okikio/wikitext/actions/workflows/ci.yml/badge.svg)](https://github.com/okikio/wikitext/actions/workflows/ci.yml)

# @okikio/wikitext

An event-stream-first wikitext source parser for Deno and npm. Parses wikitext
markup into a structured AST ("wikist": Wiki Syntax Tree, extending
[unist](https://github.com/syntax-tree/unist)) while exposing the raw event
stream as the fundamental interchange format.

The parser produces a faithful structural model of all documented wikitext
constructs. It does not expand templates or render HTML: it is a source parser.

## Features

- **Event-stream-first architecture**: events are the fundamental output; AST,
  HTML compilation, and filtering are all consumers of the same event stream.
- **Three streaming modes**: `outlineEvents()` (block-only), `events()` (full),
  and `parseChunked()` (progressive completed blocks).
- **Never throws**: produces a valid tree for any input with error recovery.
- **Round-trip fidelity**: `stringify(parse(input))` preserves the original
  wikitext.
- **UTF-16 position semantics**: offsets match `string.charCodeAt(i)` and LSP.
- **unist-compatible**: works with `unist-util-visit` and the unified ecosystem.
- **High performance**: `charCodeAt` scanning, offset-based tokens, single-pass
  with bounded lookahead, JIT-friendly hot loops.

## Install

```bash
# Deno
deno add jsr:@okikio/wikitext

# Node.js / Bun
npx jsr add @okikio/wikitext
# or
npm install @okikio/wikitext
```

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

> **Note:** `parse()`, `stringify()`, `events()`, and `outlineEvents()` are not
> yet implemented. The foundational type system (TextSource, Token, events, AST
> nodes) is complete and published. The tokenizer, parsers, tree builder,
> stringifier, and filter utilities are under active development.

You can already use the type system and builder functions:

```ts
import type { TextSource, WikitextEvent, WikistNode } from '@okikio/wikitext';
import { TokenType, isToken, root, heading, text } from '@okikio/wikitext';

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

### Pipeline modules

| Module | Purpose | Status |
|--------|---------|--------|
| `text_source.ts` | Abstracts the backing text store (string, rope, CRDT) | Published |
| `token.ts` | Token type constants and `Token` interface | Published |
| `events.ts` | Event stream types, constructors, and type guards | Published |
| `ast.ts` | Wikist AST node types, type guards, and builders | Published |
| `tokenizer.ts` | `charCodeAt` scanner over `TextSource` | Not yet implemented |
| `block_parser.ts` | Block-level event emitter | Not yet implemented |
| `inline_parser.ts` | Inline event enrichment | Not yet implemented |
| `parse.ts` | Orchestration (tokenizer, block, inline, tree) | Not yet implemented |
| `tree_builder.ts` | `buildTree(events)` to `WikistRoot` | Not yet implemented |
| `stringify.ts` | AST to wikitext (round-trip) | Not yet implemented |
| `filter.ts` | Filter/visit for tree and event streams | Not yet implemented |
| `session.ts` | Stateful `Session` wrapper for incremental use | Not yet implemented |

## API

### Parsing and serialization

| Function | Description |
|----------|-------------|
| `parse(input)` | Parse wikitext into a `WikistRoot` AST. _Not yet implemented._ |
| `stringify(tree)` | Serialize a wikist tree back to wikitext. _Not yet implemented._ |
| `events(input)` | Full event stream (block + inline). _Not yet implemented._ |
| `outlineEvents(input)` | Block-only event stream (no inline parsing). _Not yet implemented._ |
| `parseChunked(chunks)` | Progressive completed block nodes (async). _Not yet implemented._ |

### Low-level streams

| Function | Description |
|----------|-------------|
| `tokens(input)` | Raw token stream. _Not yet implemented._ |
| `buildTree(events)` | Build AST from an event iterable. _Not yet implemented._ |

### Tree utilities

| Function | Description |
|----------|-------------|
| `filter(tree, type)` | Get all nodes of a type (recursive). _Not yet implemented._ |
| `visit(tree, visitor)` | unist-compatible tree walker. _Not yet implemented._ |

### Foundation (available now)

| Export | Module | Description |
|--------|--------|-------------|
| `TextSource` | `text_source.ts` | Interface for backing text stores |
| `slice()` | `text_source.ts` | Resolve offset range to string |
| `TokenType` | `token.ts` | Constant map of all token types |
| `Token` | `token.ts` | Token interface (type + start/end offsets) |
| `isToken()` | `token.ts` | Type guard for Token validation |
| `WikitextEvent` | `events.ts` | Discriminated union of 5 event kinds |
| `enterEvent()`, `exitEvent()`, ... | `events.ts` | Event constructors |
| `isEnterEvent()`, `isExitEvent()`, ... | `events.ts` | Event type guards |
| `WikistNode` | `ast.ts` | Discriminated union of 37 node types |
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
