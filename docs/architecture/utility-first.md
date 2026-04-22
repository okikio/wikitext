# Utility-First Design

This parser is utility-first.

That means it tries to expose stable primitives that other tools can build on,
instead of turning the core parser into a giant plugin host.

## What utility-first means here

The package exposes building blocks such as:

- `TextSource`
- tokens
- events
- tree builders
- tree utilities
- session-oriented wrappers

Those are the surfaces other tools should compose.

Just as importantly, those surfaces preserve the parser's native data model:
source-backed ranges first, richer interpretations second.

## Why the parser does not lead with hooks

The repo does not currently treat deep parser hooks as the main extension
story.

That is intentional.

Deep hooks freeze a lot of internal design too early:

- ambiguity handling
- malformed-input boundaries
- hot-path control flow
- recovery and materialization policy

If those internals are still evolving, a broad hook system creates long-term
API cost very quickly.

## What to do instead

The preferred extension model is to build on the parser's public primitives.

In practice, that usually means one of these:

1. consume tokens and emit your own higher-level events
2. consume the event stream and emit your own derived events
3. build a focused mini-parser for one domain-specific construct and merge its
   output with the main parser's results
4. walk the tree and add your own interpretation layer later

This keeps the core parser small and predictable while still giving consumers a
real extension surface.

It also lets downstream tools choose when they actually need strings. Many
extensions can do their work directly from tokens, source ranges, event slices,
or tree nodes that still point back into the original source.

## The recommended mental model

Think of the package less like this:

```text
one parser you patch from the inside
```

and more like this:

```text
shared parser primitives
  -> your domain-specific logic
  -> your own events, trees, or transforms
```

If you need special behavior for one feature, it is often better to write a
small focused parser that consumes the source ranges or event slices you care
about than to ask the core parser to grow a new generic hook point.

That recommendation is partly architectural and partly practical: range-first
primitives are cheaper to compose than hook systems that force the core parser
to materialize and expose every intermediate detail eagerly.

## What stays public versus internal

Public and intended for downstream use:

- source abstractions such as `TextSource`
- token, event, and AST interfaces and unions
- builder functions and type guards
- parser stage entry points such as `tokenize()`, `blockEvents()`, and
  `inlineEvents()`

Still internal:

- scanner-local context records
- one-stage matcher result shapes
- low-level continuation helpers whose contracts are still evolving

That boundary is what keeps the package utility-first without making every
local implementation detail part of the public API.