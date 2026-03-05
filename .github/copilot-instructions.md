# Copilot Instructions (Always-On)

## Purpose

Assist a senior engineer who values clarity, reproducibility, standards/specs,
and architectural rigor. Optimize for maintainability and future-proofing
without drifting into “abstraction for abstraction’s sake”.

## About this project

`@okikio/wikitext` is an event-stream-first wikitext source parser for Deno and
npm. It parses wikitext markup into a structured AST ("wikist" — Wiki Syntax
Tree, extending unist) while exposing the raw event stream as the fundamental
interchange format.

The parser does not expand templates or render HTML. It produces a faithful
structural model of all documented wikitext constructs. MediaWiki behavioral
quirk-matching is a future "mediawiki" profile, not an MVP goal.

Flat file layout at root. `mod.ts` re-exports all public APIs. Key modules:

- `ast.ts` — wikist node types, type guards, builders
- `events.ts` — `WikitextEvent` union, constructors (range-first: offsets, not
  strings)
- `text_source.ts` — `TextSource` interface (string/rope/CRDT abstraction)
- `token.ts` — `Token` interface, `TokenType` enum
- `tokenizer.ts` — charCodeAt generator-based scanner over `TextSource`
- `block_parser.ts` — block-level event emitter
- `inline_parser.ts` — inline event enrichment
- `parse.ts` — orchestration (tokenizer → block → inline → tree)
- `tree_builder.ts` — `buildTree(events) → WikistRoot`
- `session.ts` — stateful `Session` wrapper (Phases 5–7)
- `stringify.ts` — AST → wikitext (round-trip)
- `filter.ts` — filter/visit for tree and event streams

## Architecture overview

Events — not AST — are the fundamental output. Everything else is a consumer:

```
TextSource ─► Tokenizer ─► Event Stream ─► [Consumer]
                 │                              │
                 │   charCodeAt scanner         ├─► buildTree()     → WikistRoot
                 │   Generator<Token>           ├─► compileHtml()   → string
                 │                              ├─► filterEvents()  → events
                 │                              └─► directConsumer  → callback
                 │
                 └─► raw token stream (lowest cost)
```

The pipeline accepts any `TextSource` (plain `string` satisfies the
interface). Events are range-first: text events carry offset ranges into the
source, not extracted strings.

Three streaming modes, all event-well-formed (stack discipline):

- `outlineEvents(input)` — block-only, no inline parsing
- `events(input)` — full enter/exit/text events
- `parseChunked(chunks)` — progressive completed block nodes (async)

### Parser contracts

1. **Event well-formedness** — every `enter(X)` has matching `exit(X)`, proper
   nesting (stack discipline)
2. **UTF-16 offsets** — `position.offset` is a UTF-16 code unit index (matches
   `string.charCodeAt(i)`)
3. **Never-throw** — parser produces a valid tree for any input, with optional
   error events for recovery points
4. **Determinism** — same input + same config → same events, same tree

## Commands

```bash
deno task test          # deno test --trace-leaks --v8-flags=--expose-gc
deno task bench         # run benchmarks
deno doc --lint mod.ts  # validate JSDoc on every public export
```

Always run `deno doc --lint mod.ts` after any change to the public API surface
or its documentation. It catches: missing JSDoc, `private-type-ref` errors (a
type referenced in a public signature that is not itself exported), and unnamed
`@example` blocks.

## Default operating mode

- Be high-signal and explicit.
- Prefer the smallest correct change first.
- If requirements are ambiguous, ask **one** focused question. If you can still
  move forward, propose **2–3** options with trade-offs and a recommendation.
- Don’t invent APIs/files/config. If you can’t see it, state assumptions and
  give a verification step.

## Philosophy (how to write code here)

### Standards, specs, conventions

- Prefer established standards/specs and common conventions.
- If multiple standards exist, call out differences and the practical
  trade-offs.
- Optimize for patterns that are easy to maintain, easy to follow, and easy to
  share.

### Naming

Names should be approachable and succinct, while still capturing:

- intent,
- the problem being solved,
- and the shape/nature of the solution.

Naming conventions for this project:

- AST node types: `WikistRoot`, `WikistNode`, `WikistParent`, `WikistLiteral`
- Events: `WikitextEvent`, `EnterEvent`, `ExitEvent`, `TextEvent`
- Tokens: `Token`, `TokenType`
- Parsers: `tokenize()`, `blockParse()`, `inlineParse()`
- Public API: `parse()`, `events()`, `outlineEvents()`, `stringify()`
- Source abstraction: `TextSource`
- Stateful wrapper: `Session`, `createSession()`
- Offset mapping: `PositionMap`

Docs/comments should add nuance (and confidence), not compensate for unclear
naming.

### Documentation & comments (educational codebase)

- Default: explain _why_.
- When the _what/how_ is non-obvious (regex, bitwise/binary math, tricky boolean
  logic, performance hacks), also explain _what/how_ in plain English so a
  junior dev can follow.

For complex logic, include:

- a short docstring (problem, reasoning & logic, purpose + assumptions),
- a step-by-step algorithm explanation,
- ASCII diagrams when they improve clarity.

### Error handling

- The parser never throws on any input. Malformed wikitext produces a valid
  wikist tree with error recovery.
- Use typed errors or discriminated unions when appropriate.
- Optionally emit `{ type: "error", message, position }` events for recovery
  points that consumers can log or ignore.

### Performance discipline

- `charCodeAt`, not `charAt` — avoid string allocation per character.
- Offset-based tokens (start/end into source), not value strings — avoids
  per-token allocation and V8 sliced-string retention.
- Range-first events — text events carry offset ranges, not extracted strings.
- All modules accept `TextSource`, not bare `string`.
- Single-pass scanning with bounded lookahead.
- Fresh immutable objects per yield — no object reuse across generator yields.
- JIT-friendly hot loops — no megamorphic call sites, no closures per character.

### Configuration

- Prefer explicit configuration when it materially changes behavior.
- Also choose good defaults so configuration stays minimal and unsurprising.

## Breaking changes

When making a behavioral change, touch all of these before closing the task:

1. **Confirm all behavioral changes with user** — ask for confirmation on the
   proposed change and its scope before implementing.
2. **Tests** — update or add assertions that reflect the new behavior.
3. **TSDoc** — update tsdocs behaviour explanations including `@example` blocks
   on the affected functions and types.
4. **README** — update the relevant docs sections including usage sections with
   matching examples.
5. **CHANGELOG** — note the change under the correct version heading.
6. **Instructions** — if the change affects how tests, benchmarks, commits, or
   documentation should be written, update the relevant file in
   `.github/instructions/`.

## Safety / Security / Privacy

- Default to least privilege.
- Avoid unsafe patterns (string-built SQL, unsafe eval, weak crypto).
- Don’t leak secrets in logs; call out trust boundaries for auth/permissions.

## Where to look

### Instructions (always-on rules, auto-loaded by `applyTo`)

Targeted rules live under `.github/instructions/`. These are prescriptive —
follow them whenever you work on a matching file.

| File                                | Applies to                       |
| ----------------------------------- | -------------------------------- |
| `typescript.instructions.md`        | `**/*.ts`, `**/*.tsx`            |
| `markdown-writing.instructions.md`  | `**/*.md`, `**/*.ts`, `**/*.tsx` |
| `ascii-diagrams.instructions.md`    | `**/*.ts`, `**/*.md`             |
| `testing.instructions.md`           | `**/*_test.ts`, `**/*.test.ts`   |
| `benchmarking.instructions.md`      | `**/*_bench.ts`, `**/*bench*.ts` |
| `changelog-commits.instructions.md` | `**` (all files)                 |
| `pull-requests.instructions.md`     | `**` (all files)                 |
| `code-review.instructions.md`       | `**` (all files)                 |

### Guides (situational reference, read on demand)

Reference material lives under `.agents/guides/`. These are descriptive —
read them when the task calls for it, not necessarily on every edit.

| File                   | When to read                                                |
| ---------------------- | ----------------------------------------------------------- |
| `codebase-patterns.md` | Before touching core modules — architecture, pipeline, perf |
