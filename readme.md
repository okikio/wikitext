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
const tree = parse('== Heading ==\n\nA paragraph with '''bold''' text.');

// Round-trip back to wikitext
const wikitext = stringify(tree);

// Stream events without building a tree
for (const evt of events('== Heading ==\n\nSome text.')) {
  console.log(evt.type, evt.nodeType ?? evt.value);
}

// Block-only events (cheapest structured path)
for (const evt of outlineEvents(largeArticle)) {
  if (evt.type === 'enter' && evt.nodeType === 'heading') {
    toc.push(evt);
  }
}
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

## API

| Function | Description |
|----------|-------------|
| `parse(input)` | Parse wikitext into a `WikistRoot` AST |
| `stringify(tree)` | Serialize a wikist tree back to wikitext |
| `events(input)` | Full event stream (block + inline) |
| `outlineEvents(input)` | Block-only event stream (no inline parsing) |
| `tokens(input)` | Raw token stream |
| `buildTree(events)` | Build AST from an event iterable |
| `filter(tree, type)` | Get all nodes of a type (recursive) |
| `visit(tree, visitor)` | unist-compatible tree walker |

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
