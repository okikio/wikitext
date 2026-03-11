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
  `events()`, `parse()`, `parseWithDiagnostics()`, and `parseStrict()` expose
  the current tokenizer, event, and tree layers without extra wrapper code.
- **Never throws**: preserves malformed-input findings without crashing the
  parser.
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
- `tokens()`, `outlineEvents()`, `events()`, `parse()`, `parseWithDiagnostics()`, `parseStrict()`, and `parseWithRecovery()`
- `buildTree()`, `buildTreeWithDiagnostics()`, `buildTreeStrict()`, `buildTreeWithRecovery()`, `filter()`, `visit()`, `resolveTreePath()`, `resolveDiagnosticAnchor()`, `locateDiagnostic()`, and `createSession()`

The higher-level orchestration APIs shown in some examples below are still in
progress:

- `stringify()`
- lazy tree-building mode
- `parseChunked()`

If you want the deeper design and architecture notes, start with
[docs/architecture/README.md](./docs/architecture/README.md).

If you want compact API tables, see [docs/api-reference.md](./docs/api-reference.md).

If you want more task-focused usage snippets, see [docs/examples.md](./docs/examples.md).

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
> `events()`, `parse()`, `parseWithDiagnostics()`, `parseStrict()`, `parseWithRecovery()`, `buildTree()`,
> `buildTreeWithDiagnostics()`, `buildTreeStrict()`, `buildTreeWithRecovery()`, `filter()`, `visit()`, `resolveTreePath()`,
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

## How to think about the parser

The package is easier to use if you start with the big ideas first.

The parser is event-stream-first. It notices raw syntax, turns that into
structured events, and then lets trees and other tools consume that same event
stream.

```text
Input -> Tokenizer -> Event Stream -> [Consumer]
```

That is why the package exposes more than one level of output:

- `tokens()` when you want the cheapest inspection path
- `outlineEvents()` when you only care about block structure
- `events()` when you want the full structural stream
- tree builders when you want a random-access result

The package is also utility-first. It is meant to give you stable primitives to
build on, not a giant hook surface that asks you to patch the parser from the
inside.

If you need domain-specific behavior, the usual recommendation is:

1. consume tokens or events
2. write a small focused parser or transformer for your domain
3. emit your own events, summaries, or later tree shape on top of those
  primitives

That keeps the core parser predictable while still giving downstream tooling a
real extension model.

Malformed input is part of that story too. The parser never throws on arbitrary
input, but callers should still get to choose what kind of help they want. Some
callers want the fastest tree. Some want the parser to recover on their behalf
and explain what it fixed. Some want a more diagnostics-first model where the
parser surfaces problems without already deciding all the repairs for them.

If you want the full plain-English version of that choice, see
[docs/architecture/choosing-a-tree.md](./docs/architecture/choosing-a-tree.md).

If you want the longer explanation for why the parser does not lead with deep
hooks, see [docs/architecture/utility-first.md](./docs/architecture/utility-first.md).

## Architecture at a glance

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

For the deeper architecture breakdown, see
[docs/architecture/README.md](./docs/architecture/README.md).

## One concrete parser rule: HTML-like tag commitment

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

## Choosing a result

The parser is trying to support three high-level families of result.

```text
fast tree
  no diagnostics
  no applied recovery policy

recovery tree
  diagnostics kept
  recoveries applied on your behalf

diagnostics-first tree
  diagnostics kept
  recoveries listed, not applied
```

Today's public wrappers are still converging toward that model, but this is the
rough current shape:

- `parse(input)` returns the default tree only
- `parseWithDiagnostics(input)` returns `{ tree, diagnostics }` with the same
  default tree shape as `parse(input)`
- `parseStrict(input)` returns `{ tree, diagnostics }` with a conservative tree
  that collapses recovery-heavy wrappers back to plain text when the source did
  not clearly commit to them
- `parseWithRecovery(input)` stays in the same recovery-tree family today

The key decision is not just "do I want a tree?" It is "what kind of help do I
want from the parser when the source gets messy?"

If you want the fuller explanation, including what kind of magic each tree
family should and should not perform, see
[docs/architecture/choosing-a-tree.md](./docs/architecture/choosing-a-tree.md).

Today's wrappers look like this in code:

```ts
const tree = parse(source);

const diagnostics = parseWithDiagnostics(source);
console.warn(diagnostics.diagnostics);

const conservative = parseStrict(source);
console.warn(conservative.diagnostics);

const result = parseWithRecovery(source);
if (result.recovered) {
  console.warn(result.diagnostics);
}
```

The same split exists on sessions through `session.parseWithDiagnostics()`,
`session.parseStrict()`, and `session.parseWithRecovery()`.

For event streams, diagnostics are opt-in. `events(input)` and
`outlineEvents(input)` stay on the cheapest lane by default. Pass
`{ include_diagnostics: true }` when you want parser findings preserved in the
stream.

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
