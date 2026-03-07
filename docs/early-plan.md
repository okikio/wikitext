# Plan: Wikitext Parser — Event-Driven AST Library

## TL;DR

Build `@okikio/wikitext`, an event-stream-first wikitext source parser for
Deno/npm. Syntax-first deterministic parse: correct structural model for all
documented wikitext constructs, with strong recovery (never throw). MediaWiki
behavioral quirk-matching is a future profile, not an MVP goal. Events are the
fundamental interchange format — AST ("wikist") is built on top. Architecture
supports sync pull, async chunked streaming, progressive block output,
incremental reparsing, multiple output modes (tokens → events → AST → direct
compilation), and extensibility hooks — all without changing the public API.
All modules accept `TextSource` (plain `string` satisfies the interface).
Range-first events carry offset ranges, not extracted strings.
Flat file layout; every module exports reusable utilities.

## Architecture: Events as the Interchange Layer

The key architectural insight (from micromark, pulldown-cmark, lol-html):
**events, not AST, are the fundamental output**. Everything else is a consumer.

```
TextSource ──► Tokenizer ──► Event Stream ──► [Consumer]
                   │                              │
                   │   charCodeAt scanner         ├─► buildTree()     → WikistRoot
                   │   Generator<Token>           ├─► compileHtml()   → string
                   │                              ├─► filterEvents()  → events
                   │                              ├─► directConsumer  → user callback
                   │                              └─► treeBuilder     → incremental update
                   │
                   └─► also exposes raw token stream for lowest-cost consumers
```

The pipeline accepts any `TextSource` (plain `string` satisfies the interface).
Events are range-first: text events carry offset ranges into the source, not
extracted strings. Consumers call `slice(source, evt)` to resolve text on demand.

### Event types

Events are enter/exit pairs with position data, mirroring SAX/StAX. Events
are **range-first**: text events carry offset ranges, not extracted strings.

- `enter(nodeType, props)` — opening a node (e.g., `enter("heading", {level:2})`)
- `exit(nodeType)` — closing a node
- `text(startOffset, endOffset, position)` — literal text content (resolve via
  `slice(source, startOffset, endOffset)`)
- `token(tokenType, start, end, position)` — raw token (lowest level)

This gives callers a choice:
1. **Token stream only** — cheapest, no structure, good for search/grep
2. **Event stream** — structured enter/exit pairs, no allocation, good for
   streaming transforms and direct compilation
3. **AST** — full tree, good for complex transforms, filtering, round-trip
4. **Direct compilation** — events → HTML without building a tree

## Parser Contracts

Four invariants that every API path must satisfy. Defined early because they
constrain every implementation decision that follows.

### 1. Event well-formedness (stack discipline)

Every `enter(X)` event has a matching `exit(X)`. Events form a properly nested
stack — no interleaving, no orphaned exits. This holds for all event modes
(outline, full, progressive). Consumers can rely on this for correct tree
construction, streaming HTML emission, and event filtering.

Formally: at any point in the event stream, the sequence of `enter`/`exit`
events forms a valid prefix of a well-parenthesized string.

### 2. Position semantics (UTF-16 code unit offsets)

`position.offset` is a **UTF-16 code unit index** into the original JS input
string. This matches `string.charCodeAt(i)`, `string[i]`, and `string.slice()`.
Not UTF-8 bytes, not Unicode code points.

- `line` is 1-indexed (first line = 1).
- `column` is 1-indexed, counting UTF-16 code units from start of line.
- `offset` is 0-indexed, counting UTF-16 code units from start of input.

If a consumer needs UTF-8 byte offsets (e.g., for interfacing with native
tooling), expose them opt-in via `node.data?.utf8Offset` (computed lazily).

This aligns with LSP position semantics (`utf-16` encoding mode) and avoids
subtle bugs with non-ASCII content (CJK articles, diacritics, emoji).

### 3. Never-throw guarantee

The parser never throws on any input. Malformed wikitext produces a valid
wikist tree (with error recovery). Optionally, recovery points emit
`{ type: "error", message, position }` events that consumers can log or ignore.

This is a continuous invariant enforced from Phase 2 onward — not a Phase 8
hardening pass.

### 4. Determinism

Same input + same config → same events, same tree. No randomness, no
dependency on global state, no Date.now() in output. This enables snapshot
testing, round-trip invariants, and reproducible corpus regression.

## Streaming Modes

Three named modes, all built on the same event core. Each preserves event
well-formedness within its scope.

### Mode A: Outline events (block-only)

`outlineEvents(source: TextSource): Generator<WikitextEvent>`

Emits only block-level structure: `Heading`, `List`, `Table`, `Paragraph`
boundaries. Inline content stays as opaque text ranges (raw text events).
No inline parsing cost.

Use case: table of contents, section index, document structure extraction.

```
for (const evt of outlineEvents(input)) {
  if (evt.type === "enter" && evt.nodeType === "heading") toc.push(evt)
}
```

### Mode B: Full events

`events(source: TextSource): Generator<WikitextEvent>`

Complete event stream — block structure plus inline enrichment (bold, italic,
links, templates, etc.). All nested enter/exit pairs. This is the default.

### Mode C: Progressive blocks

`parseChunked(chunks: AsyncIterable<string>): AsyncGenerator<WikistNode>`

Yields *completed block-level nodes* as soon as their closing boundary arrives.
In-order within the document, but progressive over time. Each yielded node is
a fully-parsed subtree (block + inline).

Use case: streaming rendering, progressive wiki preview, LLM streaming output.

```
for await (const node of parseChunked(stream)) {
  renderNode(node)  // heading arrives when closing "==" is seen
}
```

### Sync pull (primary, MVP)

```
function* events(source: TextSource): Generator<WikitextEvent>
function* outlineEvents(source: TextSource): Generator<WikitextEvent>
function  parse(source: TextSource): WikistRoot
```

### Async pull (chunked input — Phase 6)

```
async function* asyncEvents(chunks): AsyncGenerator<WikitextEvent>
async function* parseChunked(chunks): AsyncGenerator<WikistNode>
```

Tokenizer maintains a small carry buffer across chunk boundaries. Block parser
flushes complete blocks immediately.

### Push (SAX-style callbacks — Phase 6)

```
const parser = createParser({ onEvent(evt) { ... } })
parser.write(chunk)
parser.end()
```

Thin adapter over async events — inverts control flow.

### Deferred inline parsing (lazy tree mode — Phase 6)

`buildTree(events, { inlineMode: "lazy" })` — inline content stays as `Text`
nodes. `resolveInlines(node)` parses on-demand. "Give me all headings" never
pays for bold/italic in paragraphs. Text nodes store their source range;
resolveInlines re-runs the inline parser on that range.

### Incremental parsing (edit resilience — Phase 7)

Goal: reparse only the affected region after an edit, reuse everything else.

**How it works:**
1. During full parse, record a compact **state snapshot** at each block
   boundary: `{ inNowiki, inPre, openTagStack, openTemplateDepth, inTable }`.
2. On edit, caller provides `(oldTree, editRange, newText)`.
3. Find affected blocks: any block whose source range overlaps `editRange`.
4. Walk backward from the first affected block to the nearest boundary whose
   state snapshot is "neutral" (all stacks empty, no open spans). This is the
   actual reparse start — it catches cases where a template or tag spans
   multiple blocks (e.g., `{{ ... \n ... }}`).
5. Re-tokenize from the neutral boundary through the dirty range.
6. Re-parse affected blocks. Compare new block-start sequence to old one;
   expand dirty range if structural boundaries shifted.
7. Splice new blocks into old tree, reuse untouched subtrees by reference.
8. Return new root.

**Why state snapshots matter:** block boundaries alone are not sufficient.
Templates can span lines (`{{ ... \n ... }}`). Nowiki/pre/ref blocks suppress
parsing across line boundaries. Tables leave the parser in a non-neutral state
at line boundaries. Without state snapshots, an edit that closes a template
or opens a nowiki block can silently change interpretation of later blocks.

**File:** `incremental.ts` — `reparseIncremental(oldTree, edit) → WikistRoot`

## Key Decisions

- **Spec name**: "wikist" (Wiki Syntax Tree), following mdast/hast/xast pattern
- **File layout**: Flat files at root alongside mod.ts — no src/ folder. All
  functions exported as utilities.
- **Scope**: Syntax-first deterministic parse for all documented wikitext
  constructs. Exceeds mwparserfromhell structurally (proper lists, tables,
  semantic formatting, image/category/definition-list). Source parser only — no
  template expansion or rendering. MediaWiki behavioral quirk-matching (exact
  apostrophe heuristics, edge case rendering parity) deferred to a future
  "mediawiki" profile.
- **Events-first**: Events are the interchange layer. AST is a consumer. Three
  named event modes: `outlineEvents()` (block-only), `events()` (full),
  `parseChunked()` (progressive completed blocks). All preserve well-formedness.
- **Range-first events**: Text/token events carry `startOffset`/`endOffset` into
  the `TextSource`, not extracted `value` strings. `slice(source, evt)` resolves
  on demand. Avoids per-event string allocation.
- **TextSource abstraction**: Minimal interface (`length`, `slice`, `charCodeAt`,
  optional `iterSlices`) abstracts the backing text store. Plain `string`
  satisfies it. Rope trees, CRDTs, and append buffers can implement it for
  zero-copy access. Defined in Phase 1; all modules accept `TextSource`.
- **Positions**: UTF-16 code unit offsets (matching JS string indexing). Line
  and column are 1-indexed. UTF-8 byte offsets opt-in via `data` slots.
- **Token representation**: Tokens carry start/end offsets into the source, not
  `value` strings. A `slice(source, token)` helper resolves strings on demand.
  Avoids per-token allocation and V8 sliced-string retention hazard.
- **Session API**: Stateful wrapper (`createSession(source)`) built on stateless
  pipeline. Phase 5: basic (events/outline/parse). Phase 6: streaming
  (write/drain). Phase 7: incremental (applyChanges/PositionMap).
- **Stability frontier**: During streaming, UTF-16 offset up to which events are
  guaranteed stable. Stable prefix grows monotonically as input appends.
- **PositionMap**: Old-offset → new-offset mapping returned by `applyChanges()`.
  Covers ~80% of anchor use cases without a dedicated Anchor API.
- **Conflict node**: Reserved `type: "conflict"` in wikist spec. Not produced by
  core parser — intended for collab/merge tooling (jj-inspired).
- **Hybrid editing design constraint**: Text is truth, structure is overlay.
  Local markup hiding, bounded reflow. We are not building an editor — we are
  providing the structural API an editor needs.
- **CST vs AST**: AST with position info for source mapping. Full CST possible
  later — events already carry the information.
- **Research and docs**: Live in `docs/` folder.
- **Perf target**: Best-in-class JS throughput on real Wikipedia corpora,
  predictable latency, correctness. Architecture stays open so a WASM backend
  could replace a hot path without changing the public API.
- **Profiles**: Named presets for parser config. `syntax` (MVP default) uses
  deterministic rules. `mediawiki` (Phase 8) matches MediaWiki's exact quirks.
  Profiles are sugar over feature gates — not a separate pipeline.
- **Extension model**: Construction-time specialization — feature gates produce
  a specialized parser instance. Extensions run as event enrichment passes, not
  in the tokenizer hot loop.
- **Hardening early**: Fuzz from Phase 3, corpus regression from Phase 5.
  "Never throw" is a continuous invariant, not a Phase 8 bolt-on.

## Capabilities Matrix

| Capability | MVP (Phases 0-5) | Advanced (Phases 6-8) |
|------------|-------------------|-----------------------|
| Sync pull parse | Yes | — |
| Full AST (wikist) | Yes | — |
| Token stream (offset-based) | Yes | — |
| Full event stream (`events()`) | Yes | — |
| Outline event stream (`outlineEvents()`) | Yes | — |
| Range-first events (no value strings) | Yes | — |
| `TextSource` abstraction | Yes | — |
| Filter/visit API | Yes | — |
| Round-trip stringify | Yes | Minimal-diff mode |
| Error recovery (never-throw) | Yes | — |
| Source positions (UTF-16 offset + line/col) | Yes | — |
| unist compatibility | Yes | — |
| Fuzz testing (never-throw invariant) | Phase 3 onward | Scaled up |
| Corpus regression snapshots | Phase 5 onward | Scaled up |
| `createSession()` (basic) | Phase 5 | — |
| Async chunked streaming | — | Phase 6 |
| Push/SAX-style API | — | Phase 6 |
| Progressive blocks (`parseChunked()`) | — | Phase 6 |
| Deferred inline parsing (lazy tree) | — | Phase 6 |
| `session.write()` + stability frontier | — | Phase 6 |
| Incremental reparsing (state snapshots) | — | Phase 7 |
| `session.applyChanges()` + `PositionMap` | — | Phase 7 |
| Edit coalescing | — | Phase 7 |
| Direct HTML compilation | — | Phase 7 |
| Selective serialization (min-diff) | — | Phase 7 |
| Extension hooks (construction-time) | — | Phase 8 |
| Profiles (`syntax`, `mediawiki`) | `syntax` (default) | `mediawiki` (Phase 8) |
| Template resolver interface | — | Phase 8 |
| unified plugin pair | — | Phase 8 |
| `Conflict` node type | — | Phase 8 (optional) |
| Anchor API | — | Phase 8 or separate pkg |

## mwparserfromhell Gap Analysis (structural advantages)

mwparserfromhell has 11 node types: Text, Heading, Template, Argument, Wikilink,
ExternalLink, HTMLEntity, Comment, Tag, Attribute, Parameter.

**Structural gaps we close (syntax-first scope):**
- Lists: mwparserfromhell parses `# item` as flat Tag+Text. We model
  `List > ListItem` with proper nesting and definition lists.
- Tables: mwparserfromhell has Tag-like table nodes but no first-class table
  model (rows/cells/caption). We model full
  `Table > TableCaption / TableRow > TableCell` hierarchy.
- Bold/Italic: mwparserfromhell parses `''`/`'''` into style tags by default
  (skip_style_tags option exists) but does not model them as a semantic
  emphasis layer. We have `Bold`, `Italic`, `BoldItalic` parent nodes.
- Image/Category: mwparserfromhell treats `[[File:...]]` and `[[Category:...]]`
  as generic Wikilink with no namespace dispatch. We have distinct `ImageLink`
  and `CategoryLink`, with leading-colon escape (`[[:Category:Foo]]` →
  Wikilink).
- Redirect: No distinct node in mwparserfromhell. We have `Redirect`.
- Behavior switches: `__TOC__`, `__NOTOC__`, etc. — not modeled in
  mwparserfromhell. We have `BehaviorSwitch`.
- Parser functions: `{{#if:...}}` (identified by `#` prefix) treated as
  Template in mwparserfromhell. We have `ParserFunction`. Variable-style
  magic words (`{{PAGENAME}}`) parse as `Template` by default; profiles
  reclassify.
- Streaming/incremental: mwparserfromhell is batch-only. We stream.

---

## Phase 0 — Rewrite Copilot Instructions

Swap undent-specific content for wikitext-parser guidance. Keep the structural
patterns (tables, checklists, style) already in place.

**What changes:**
- `copilot-instructions.md`: project description, commands, architecture
  overview (event layer, streaming modes), breaking changes checklist
- `typescript.instructions.md`: add wikist type naming conventions
  (`WikistNode`, `WikitextToken`, `WikitextEvent`, `WikistRoot`, etc.)
- `testing.instructions.md`: replace undent edge cases with wikitext edge cases
  (unclosed tags, apostrophe runs, nested templates, mixed list markers,
  malformed tables, round-trip invariants, event-stream assertions)
- `benchmarking.instructions.md`: update competitor list (wtf_wikipedia,
  wikiparser-node as JS benchmarks) and benchmark modes (token-only,
  events-only, full-AST, round-trip)
- Leave `changelog-commits`, `pull-requests`, `code-review`,
  `markdown-writing`, `ascii-diagrams` untouched — they're generic

**Also in this phase:**
- `changelog.md` — reset for new project
- `readme.md` — stub rewrite (expand later)
- `scripts/build_npm.ts` — update package name/description

**Files to modify:**
- `.github/copilot-instructions.md`
- `.github/instructions/typescript.instructions.md`
- `.github/instructions/testing.instructions.md`
- `.github/instructions/benchmarking.instructions.md`
- `changelog.md`
- `readme.md`
- `scripts/build_npm.ts`

## Phase 1 — AST Specification ("wikist") + Event Types + TextSource

Define wikist node types (extending unist), the event interface that
produces them, and the `TextSource` abstraction. The event types must be
defined first — they are the contract between tokenizer/parsers and all
consumers. Events are **range-first**: text/token events carry offset
ranges, not extracted strings.

### TextSource interface

```
interface TextSource {
  readonly length: number;
  charCodeAt(index: number): number;
  slice(start: number, end: number): string;
  iterSlices?(start: number, end: number): Iterable<string>; // optional
}
```

Plain `string` satisfies this interface. Rope trees, CRDTs (Yjs `Y.Text`),
and append buffers can implement it too. All tokenizer/parser modules accept
`TextSource` instead of `string`.

### Event interface

```
WikitextEvent =
  | { type: "enter"; nodeType: string; props: Record<string, unknown>;
      position: Position }
  | { type: "exit";  nodeType: string; position: Position }
  | { type: "text";  startOffset: number; endOffset: number;
      position: Position }
  | { type: "token"; tokenType: TokenType; start: number; end: number;
      position: Position }
```

Text and token events carry offset ranges into the `TextSource` — not
extracted `value` strings. Consumers call `slice(source, evt.startOffset,
evt.endOffset)` to resolve text on demand.

### Node types (26+)

| Category | Nodes | Parent? |
|----------|-------|---------|
| Root | `Root` | Parent |
| Block | `Heading`, `Paragraph`, `ThematicBreak`, `Preformatted` | Parent (ThematicBreak is leaf) |
| List | `List`, `ListItem`, `DefinitionList`, `DefinitionTerm`, `DefinitionDescription` | Parent |
| Table | `Table`, `TableCaption`, `TableRow`, `TableCell` | Parent |
| Inline formatting | `Bold`, `Italic`, `BoldItalic` | Parent |
| Links | `Wikilink`, `ExternalLink`, `ImageLink`, `CategoryLink` | Parent |
| Templates | `Template`, `TemplateArgument`, `Argument` | Parent |
| HTML | `HtmlTag`, `HtmlEntity` | HtmlTag=Parent, HtmlEntity=Literal |
| Literal content | `Text`, `Nowiki`, `Comment` | Literal |
| Special | `Redirect`, `Signature`, `MagicWord`, `BehaviorSwitch`, `ParserFunction`, `Break`, `Gallery`, `Reference` | varies |

### unist compatibility

Every node has `type: string` and optional `position: { start: Point, end: Point }`.
Parent nodes have `children: WikistNode[]`. Literal nodes have `value: string`.
Discriminated union on `type` field enables exhaustive pattern matching.

### Type guards and builders

Export type guard functions (`isHeading()`, `isTemplate()`, etc.) and builder
helpers (`heading(level, children)`, `text(value)`, etc.) for ergonomic tree
construction and filtering.

**Files:**
- `text_source.ts` — `TextSource` interface, `slice(source, start, end)` helper
- `ast.ts` — all type definitions, discriminated union, type guards, builders.
  `Conflict` type reserved in union (no guards/builders in MVP).
- `events.ts` — `WikitextEvent` union type, range-first event constructors,
  event type guards. Shared by tokenizer, parsers, and all consumers.

## Phase 2 — Tokenizer (Iterator Core)

Character-level scanner yielding typed tokens via `Generator<Token>`.
charCodeAt-based scanning over `TextSource` for performance. The tokenizer is
the lowest layer; it feeds the event emitter.

### Token categories

- **Structural (line-start):** HEADING_MARKER, HR, TABLE_START, TABLE_END,
  TABLE_ROW, TABLE_CELL, TABLE_HEADER_CELL, TABLE_CAPTION,
  LIST_BULLET, LIST_NUMBER, LIST_INDENT, LIST_DEFINITION_TERM,
  LIST_DEFINITION_DESC
- **Inline delimiters:** APOSTROPHE_RUN, LINK_OPEN, LINK_CLOSE, PIPE,
  EXT_LINK_OPEN, EXT_LINK_CLOSE, TEMPLATE_OPEN, TEMPLATE_CLOSE,
  ARGUMENT_OPEN, ARGUMENT_CLOSE, EQUALS
- **Content:** TEXT, WHITESPACE, NEWLINE, EOF
- **Special:** COMMENT, NOWIKI_OPEN, NOWIKI_CLOSE, HTML_TAG_OPEN,
  HTML_TAG_CLOSE, HTML_SELF_CLOSE, MAGIC_WORD, BEHAVIOR_SWITCH,
  REDIRECT, SIGNATURE

### Design choices

- `function* tokenize(source: TextSource): Generator<Token>` — main entry
- Track line/column/offset for every token's start and end position
- Pre-scan comment and nowiki regions to protect their content from tokenization
- Apostrophe runs emitted as single APOSTROPHE_RUN(length) token —
  disambiguation deferred to inline parser
- Table/list markers only recognized at line start (after optional whitespace)

### Performance discipline (applied here, influences all phases)

- **charCodeAt, not charAt** — avoid string allocation per character
- **Offset-based tokens, not string values** — tokens carry `start` and `end`
  offsets into the `TextSource`, not a `value` substring. A `slice(source, token)`
  helper resolves the string on demand. This avoids per-token allocation and
  sidesteps V8's sliced-string retention hazard (a small slice can pin the
  entire parent string in memory).
- **Range-first events** — text events carry `startOffset`/`endOffset`, not
  `value` strings. Same benefits as offset-based tokens, applied to events.
- **No object reuse across yields** — each yielded token is a fresh, immutable
  object. Object reuse in generators is a footgun: consumers retain references
  and see mutated data. Fresh small objects are cheap with modern GC; the real
  win is avoiding strings, not objects.
- **Single pass** — the tokenizer never backtracks more than a bounded lookahead
  (max: length of longest possible marker, which is `{{{` = 3 chars for
  argument open, or `<!--` = 4 chars for comment).
- **Bounded buffering in streaming** — when consuming chunked input (Phase 6),
  the tokenizer carries at most one incomplete line plus the lookahead buffer.
- **JIT-friendly hot loop** — no megamorphic call sites, no closures allocated
  per character, tight switch on charCode in the inner loop.

**Files:**
- `token.ts` — Token interface, TokenType enum
- `tokenizer.ts` — generator-based scanner, exported utilities

## Phase 3 — Block Parser (Event Emitter)

Consumes the token stream, emits block-level events (enter/exit pairs).
Line-oriented. This is where the event stream first materializes structured
data. Also records **state snapshots** at block boundaries for incremental
reparsing (Phase 7).

### Strategy

- Pull tokens one "line" at a time from the iterator
- First token(s) of line determine block type:
  `=` → Heading, `*` → List (bullet), `#` → List (ordered),
  `:` → indented/DefinitionDescription, `;` → DefinitionTerm,
  `{|` → Table, `----` → ThematicBreak, ` ` → Preformatted,
  else → Paragraph
- Emit `enter(blockType, props)` immediately when block is identified
- Emit content tokens as `text(...)` events within the block
- Emit `exit(blockType)` at block boundary
- Explicit stack for nested structures (lists within lists, tables within tables)
- List nesting: `***` = 3-deep bullet list. Emit nested
  enter(list) → enter(listItem) → enter(list) → ... chain.
  Definition lists (`; term : description`) get proper DL/DT/DD events.
- Tables: `{|` opens, `|}` closes, `|-` = new row, `!` = header cell,
  `|` = data cell, `|+` = caption.

### State snapshots (for incremental reparsing)

At each block boundary, record a compact state object:
`{ inNowiki, inPre, openTagStack, openTemplateDepth, inTable }`.
Stored alongside the block's position data. Enables Phase 7's incremental
algorithm to find the nearest "neutral boundary" (all stacks empty) when
determining where to start reparsing after an edit.

### Fuzz testing starts here

As soon as Phase 3 is functional, add a basic fuzz harness:
- Generate random strings containing wikitext markers
- Assert the parser never throws (never-throw contract)
- Assert event well-formedness (every enter has matching exit)
- Run as part of `deno task test` on a small corpus; scale up in CI

**Output:** a `Generator<WikitextEvent>` of block-level enter/exit/text events.
Inline content within blocks is emitted as raw text events (not yet parsed).
A consumer that wants only block structure stops here — this is `outlineEvents()`.

**Files:**
- `block_parser.ts` — block parser, state snapshot recording, exported utilities

## Phase 4 — Inline Parser (Event Enrichment)

Consumes block-level events, expands inline markup within text events into
finer-grained enter/exit/text events.

### Strategy

- Recursive descent with explicit stack for nesting
- **Apostrophe-run algorithm**: Match MediaWiki's heuristic — 2=italic,
  3=bold, 5=bold+italic, 4=one literal apostrophe + bold, other lengths
  reduce similarly. End-of-line cleanup for unclosed runs.
- **Wikilinks**: `[[target|display]]` — detect File:/Image: namespace →
  `ImageLink`, Category: namespace → `CategoryLink`, else → `Wikilink`.
  Handle nested `[[` inside template args.
- **External links**: `[url text]` and bare URLs
- **Templates**: `{{name|arg1|key=value}}` — named/positional args as
  TemplateArgument events. Detect `{{#if:...}}` → ParserFunction.
  `{{{param|default}}}` → Argument (triple braces).
- **HTML tags**: Self-closing, void elements, matching open/close pairs.
  <ref>, <nowiki>, <pre>, <gallery>, <syntaxhighlight>, <math>, etc.
- **Special**: `~~~`/`~~~~`/`~~~~~` → Signature, `__TOC__` → BehaviorSwitch,
  `#REDIRECT [[...]]` → Redirect, `&amp;` → HtmlEntity

**Output:** a `Generator<WikitextEvent>` with all events (block + inline).
This is the "fully resolved" event stream that the tree builder consumes.

**Files:**
- `inline_parser.ts` — inline parser, exported utility functions

## Phase 5 — Public API, Tree Builder & Filter Utilities

### Core API (sync pull — MVP)

- `events(source: TextSource): Generator<WikitextEvent>` — full event stream
  (tokenize → block events → inline events). The fundamental API.
- `outlineEvents(source: TextSource): Generator<WikitextEvent>` — block-only
  event stream. Skips inline parsing. Cheapest structured path.
- `tokens(source: TextSource): Generator<Token>` — raw token stream only.
  Cheapest path for search/grep use cases.
- `parse(source: TextSource): WikistRoot` — convenience: `buildTree(events(source))`.
  The "just give me a tree" API.
- `stringify(tree: WikistRoot): string` — AST → wikitext (round-trip)
- `buildTree(events: Iterable<WikitextEvent>, options?): WikistRoot` —
  explicit tree builder. Options include `{ inlineMode: "eager" | "lazy" }`.
- `slice(source: TextSource, start: number, end: number): string` — resolve
  text from its offset range. Avoids upfront allocation.

All functions that accept `source` also accept plain `string` (which satisfies
`TextSource`).

### Session API (stateful wrapper — basic)

- `createSession(source: TextSource): Session`
- `session.events()` / `session.outline()` / `session.parse()` — cached
  delegates to pipeline functions
- Caches parse state for repeated access to the same source

### Filter API (inspired by mwparserfromhell, improved)

- `filter(tree, type)` — get all nodes of a type (recursive)
- `filterTemplates(tree)`, `filterLinks(tree)`, `filterImages(tree)`,
  `filterLists(tree)`, `filterTables(tree)`, `filterCategories(tree)` — typed
  convenience filters
- `visit(tree, visitor)` — unist-compatible tree walker
- `matches(node, name)` — template/link name matching with normalization

### Event-level filter utilities

- `filterEvents(events, predicate)` — streaming filter over event iterable
- `collectEvents(events, nodeType)` — collect all events between matching
  enter/exit pairs for a given node type

### Corpus regression starts here

Once `parse()` and `stringify()` work, add corpus-based regression tests:
- Parse 20+ real Wikipedia articles (Featured Articles), snapshot the ASTs
- Detect regressions on any code change
- Verify round-trip invariant: `parse(stringify(parse(x)))` deep-equals
  `parse(x)` on all corpus articles
- Scale to 100+ articles in Phase 8

**Files:**
- `mod.ts` — re-exports all public APIs from all modules
- `parse.ts` — orchestrates tokenizer → block → inline → tree builder
- `tree_builder.ts` — `buildTree(events) → WikistRoot`, supports lazy mode
- `stringify.ts` — AST → wikitext
- `filter.ts` — filter/visit utilities for both tree and event streams
- `session.ts` — `createSession()`, basic stateful wrapper

---

## Phase 6 — Streaming & Progressive Output

*Depends on: Phases 2-5 (core pipeline must be stable)*

### Session streaming API

- `session.write(chunk: string): void` — append text to the backing store
- `session.drainStableEvents(): WikitextEvent[]` — return events whose source
  range is before the stability frontier
- `session.stabilityOffset: number` — UTF-16 offset up to which events are
  stable (won't change). Grows monotonically as input appends.

The stability frontier divides the event stream:
```
[───── stable prefix ──────][── provisional tail ──]
                              ▲
                       stabilityOffset
```

Heuristic: block boundaries act as natural stability points. Text before a
completed block boundary is stable; text after the last closed block is
provisional.

### Async chunked streaming

- `asyncEvents(chunks: AsyncIterable<string>): AsyncGenerator<WikitextEvent>`
- `asyncOutlineEvents(chunks): AsyncGenerator<WikitextEvent>` — block-only async
- Tokenizer maintains carry buffer across chunk boundaries (at most one
  incomplete line + lookahead)
- Block parser flushes complete blocks immediately — consumer sees heading
  events before the document is fully received
- Useful for: network streams, file streams, chat/LLM streaming output,
  progressive wiki rendering

### Push API (SAX-style, wraps Session)

- `createParser(handlers: EventHandlers): PushParser`
- `parser.write(chunk: string): void`
- `parser.end(): void`
- Thin adapter that wraps `session.write()` + `session.drainStableEvents()`
  and inverts control flow
- Handlers: `{ onEnter, onExit, onText, onToken, onError, onEnd }`

### Progressive blocks

- `parseChunked(chunks: AsyncIterable<string>): AsyncGenerator<WikistNode>`
- Yields completed block-level nodes as they form (in document order)
- Each yielded node is a fully-parsed subtree (block + inline)
- Headings yield when closing `==` arrives; tables yield when `|}` is seen;
  paragraphs yield at next blank line or block-start marker

### Deferred inline parsing (lazy tree mode)

- `buildTree(events, { inlineMode: "lazy" })` — inline content stays as `Text`
  nodes until explicitly resolved
- `resolveInlines(node: WikistNode): void` — parse inline content on-demand
- Text nodes store their source range; `resolveInlines` re-runs the inline
  parser on that range

**Files:**
- `session.ts` — extended: `.write()`, `.drainStableEvents()`, stability frontier
- `async_tokenizer.ts` — async generator wrapper over core tokenizer with
  carry buffer
- `push_parser.ts` — SAX-style push API adapter (wraps session)
- `tree_builder.ts` — extended with lazy inline mode

## Phase 7 — Incremental Parsing & Direct Compilation

*Depends on: Phase 5 (tree builder), Phase 6 (async streaming)*

### Session incremental API

- `session.applyChanges(edits: Edit[]): PositionMap`
- `Edit = { offset: number; deleteCount: number; insertText: string }`
- Returns `PositionMap` — old-offset → new-offset mapping
- **Edit coalescing**: adjacent/overlapping edits merged into one reparse window
  before the actual reparse runs. Reduces wasted work for burst edits.

### PositionMap

Maps old offsets to new offsets across one or more edits:
- `positionMap.mapOffset(oldOffset): number` — returns new offset
- `positionMap.mapRange(start, end): [number, number]`
- Covers ~80% of "anchor" use cases (cursor, annotation, selection, highlight)
  without a dedicated Anchor API.

### Incremental reparsing

- `reparseIncremental(oldTree: WikistRoot, edit: EditRange): WikistRoot`
- `EditRange = { offset: number; deleteCount: number; insertText: string }`
- Algorithm:
  1. Find affected blocks via source range overlap
  2. Walk backward to nearest block boundary with a "neutral" state snapshot
     (all stacks empty — no open template, nowiki, pre, or table context).
     This handles cross-block spans like `{{ ... \n ... }}`.
  3. Re-tokenize from neutral boundary through dirty range
  4. Re-parse affected blocks, recording new state snapshots
  5. Compare new block-start sequence to old; expand dirty range forward if
     structural boundaries shifted
  6. Splice new blocks into old tree, reuse untouched subtrees by reference
  7. Return new root
- State snapshots recorded during Phase 3 enable this without full reparse
- Store block source ranges in `position` (already required for unist compat)

### Direct HTML compilation (no tree)

- `compileHtml(input: string): string` — events → HTML string, no AST
- `compileHtmlStream(events): Generator<string>` — streaming HTML chunks
- Uses event stream directly, maps enter/exit to HTML open/close tags
- Fastest path for "I just want HTML" use case
- Wikitext → HTML mapping: heading → `<h1>`..`<h6>`, bold → `<b>`,
  list → `<ul>`/`<ol>`, table → `<table>`, etc.

### Minimal-diff round-trip (selective serialization)

- `stringifySelective(tree, dirtyNodes: Set<WikistNode>): string`
- Only re-serialize modified subtrees; copy original source text for
  untouched regions
- Requires position data and access to original source string
- Minimizes diffs for "parse → modify one template → write back" workflows

**Files:**
- `session.ts` — extended: `.applyChanges()`, edit coalescing, PositionMap return
- `incremental.ts` — `reparseIncremental()`, dirty-range detection
- `position_map.ts` — `PositionMap` class, old→new offset mapping
- `compile_html.ts` — direct events → HTML compilation
- `stringify.ts` — extended with `stringifySelective()`

## Phase 8 — Extension Hooks, Unified Integration & Hardening

*Depends on: Phase 7 (core must be fully stable before opening extension points)*

### Conflict node type (optional)

The `Conflict` node type was reserved in Phase 1. Here it gets an actual
implementation for merge/collab tooling:
- `{ type: "conflict", variants: WikistNode[][] }` — structurally divergent
  interpretations of the same source region
- Produced by external merge tooling, not by the core parser
- Inspired by jj's conflict markers

### Anchor API (optional, may be separate package)

If `PositionMap` from Phase 7 doesn't cover enough anchor use cases:
- `session.createAnchor(offset, bias)` — named offset that survives edits
- `Anchor` updates automatically when `applyChanges()` runs
- Bias: "before" (attach to character before offset) or "after"
- Evaluate whether this belongs in core or a separate `@okikio/wikitext-anchors`
  package.

### Collab engine adapters (separate package territory)

- Yjs adapter: `Y.Text` → `TextSource` + `Y.Text.observe` → `Edit[]`
- Automerge adapter: similar pattern
- These are external packages, not core. The core provides the seams
  (`TextSource`, `Edit`, `PositionMap`, `Conflict`) and adapters live outside.

### Extension model (construction-time specialization)

Extensions do not touch the tokenizer hot loop. Instead:

1. **Construction-time config** produces a specialized parser instance. Feature
   gates are resolved once at construction — the resulting instance has its
   token dispatch table and event handler table baked in. No per-character flag
   checks.

2. **Extensions run as event enrichment passes**, not as tokenizer hooks:
   - **Tag handlers**: `registerTagHandler(tagName, handler)` — custom behavior
     for extension tags like `<ref>`, `<math>`, `<graph>`. Handler receives raw
     content + attributes from an event slice, returns wikist subtree or opaque
     node. Default: unknown tags → opaque `HtmlTag` with raw content.
   - **Template resolver interface**: `setTemplateResolver(resolver)` — optional
     hook for template expansion. Default: no expansion (source parser mode).
     Resolver is `(name: string, args: TemplateArg[]) → WikistNode[] | null`.
   - **Feature gates**: `{ tables: true, templates: true, htmlTags: true,
     parserFunctions: false }`. Controls which syntax constructs the parser
     recognizes.
   - **AST data slots**: every node has an optional `data: Record<string, unknown>`
     field (per unist spec) for extension metadata.

This two-phase model (construction → execution) keeps the inner loop tight:
no dynamic dispatch, no megamorphic call sites, no closure allocation per event.

### Profiles (named presets for parser config)

A profile is a named bundle of feature gates + ambiguity resolution rules.
Profiles are sugar over the construction-time config — not a separate pipeline.

- `profile: "syntax"` — deterministic structural parse with clean recovery
  rules (the MVP default, Phases 1-5). Does not attempt to match MediaWiki
  rendering quirks.
- `profile: "mediawiki"` — matches MediaWiki's actual parsing behavior for
  ambiguous constructs: exact apostrophe heuristic, unclosed-tag recovery
  matching Preprocessor_DOM.php, table edge cases, etc. Added when the
  conformance suite has enough test vectors to verify compatibility.

Usage:
```
const parser = createParser({ profile: "mediawiki" })
```

Profiles compose with feature gates — a profile sets defaults, explicit gates
override them.

### Unified integration

- `wikitextParse()` — unified parser plugin (string → wikist)
- `wikitextStringify()` — unified compiler plugin (wikist → string)
- `wikistToHast()` — bridge plugin (wikist → hast for HTML output)
- `wikistToMdast()` — experimental bridge (wikist → mdast for markdown output)

### Test hardening (scaling up from Phases 3/5)

Building on the fuzz harness from Phase 3 and corpus snapshots from Phase 5:

- **Corpus-based regression (scaled)**: expand to 100+ real Wikipedia articles
  (Featured Articles corpus), including CJK, RTL, and heavily-templated pages.
  Snapshot ASTs, detect regressions on any code change.
- **Fuzzing (scaled)**: expand from Phase 3's basic harness to 10K+ random
  inputs per CI run. Include structured fuzzing with valid wikitext fragments
  combined randomly. Verify parser never throws, always produces valid wikist
  tree, and round-trip is stable.
- **Round-trip invariants**: `parse(stringify(parse(x))) deep= parse(x)` for
  all inputs in the full corpus
- **Conformance suite**: curated test cases for every node type, every error
  recovery path, every edge case from the MediaWiki parser (apostrophe
  heuristics, nested template edge cases, table-in-list, etc.)
- **Event-stream invariants**: every `enter` has matching `exit`, nesting is
  well-formed, positions are monotonically increasing, offsets are valid UTF-16
  indices into the input

**Files:**
- `extensions.ts` — tag handler registry, template resolver interface,
  feature gate config
- `unified.ts` — unified plugin wrappers
- `docs/wikist-spec.md` — formal AST specification
- `docs/architecture.md` — pipeline architecture, streaming model, extension
  points
- Tests: corpus tests in `tests/corpus/`, fuzz harness, conformance suite

---

## Files Summary

### Modify
- `.github/copilot-instructions.md`
- `.github/instructions/typescript.instructions.md`
- `.github/instructions/testing.instructions.md`
- `.github/instructions/benchmarking.instructions.md`
- `deno.json` — exports map for multi-module
- `mod.ts` — complete rewrite
- `readme.md` — stub, then expand
- `changelog.md` — reset
- `scripts/build_npm.ts` — package name/description

### Create (MVP — Phases 1-5)
- `text_source.ts` — TextSource interface, slice helper
- `ast.ts` — wikist node types, type guards, builders (Conflict reserved)
- `events.ts` — WikitextEvent types, range-first event constructors, type guards
- `token.ts` — Token interface, TokenType enum
- `tokenizer.ts` — generator-based scanner over TextSource
- `block_parser.ts` — block-level event emitter
- `inline_parser.ts` — inline event enrichment
- `parse.ts` — orchestration (events → tree pipeline)
- `tree_builder.ts` — buildTree(events) → WikistRoot
- `stringify.ts` — AST → wikitext
- `filter.ts` — filter/visit for tree and event streams
- `session.ts` — createSession(), basic stateful wrapper
- Tests: `text_source_test.ts`, `ast_test.ts`, `events_test.ts`,
  `tokenizer_test.ts`, `block_parser_test.ts`, `inline_parser_test.ts`,
  `parse_test.ts`, `filter_test.ts`, `session_test.ts`

### Create (Advanced — Phases 6-8)
- `async_tokenizer.ts` — async chunked tokenizer
- `push_parser.ts` — SAX-style push API (wraps session)
- `incremental.ts` — incremental reparsing
- `position_map.ts` — PositionMap (old→new offset mapping)
- `compile_html.ts` — direct events → HTML
- `extensions.ts` — tag handler registry, template resolver, feature gates
- `unified.ts` — unified plugin wrappers
- `docs/wikist-spec.md`, `docs/architecture.md`
- `tests/corpus/` — real Wikipedia article snapshots
- Fuzz harness, conformance suite

### Delete (old undent code)
- `mod_memory_test.ts`
- `mod_bench.ts`
- `_repl.ts`

## Verification

### MVP (Phases 0-5)
1. `deno check mod.ts` — type-checks all modules
2. `deno doc --lint mod.ts` — validates JSDoc on public exports
3. `deno task test` — all test files pass
4. Round-trip: `stringify(parse(input)) ≈ input` for canonical wikitext samples
5. Event-stream well-formedness: every enter has matching exit, positions
   monotonically increase, nesting is balanced
6. Token-stream completeness: `tokens(input)` covers every UTF-16 code unit
   of input with no gaps and no overlaps
7. Position correctness: all offsets are valid UTF-16 indices into the input;
   `input.slice(pos.start.offset, pos.end.offset)` returns the expected text
8. Never-throw: fuzz harness (from Phase 3) confirms parser produces a tree
   for all random inputs
9. Corpus regression: 20+ Wikipedia articles (from Phase 5) snapshot ASTs,
   zero regressions on code changes
10. Benchmark `parse()` against wtf_wikipedia and wikiparser-node
11. unist compat: `unist-util-visit` works on output tree
12. Filter API: `filterTemplates(parse(wikitext))` returns correct results
    compared to mwparserfromhell output on same input
13. Edge cases: unclosed tags, malformed tables, mixed list markers, apostrophe
    edge cases, nested templates in links
14. `outlineEvents()`: produces well-formed block-only events, no inline
    parsing cost (verify by timing comparison)

### Advanced (Phases 6-8)
15. Async streaming: parse a 1MB article from chunked input, verify output
    matches batch parse
16. Incremental: edit a single paragraph in a 10-section document, verify only
    affected region is re-parsed (measure by counting tokenizer calls). Test
    cross-block spans: edit that closes a template on a different line.
17. State snapshots: verify neutral-boundary detection catches edits to
    nowiki blocks, multi-line templates, and table contexts
18. Direct HTML compilation: output matches `parse` → `compileHtml` path
19. Fuzzing (scaled): 10K+ random inputs, parser never throws, tree always valid
20. Corpus regression (scaled): 100+ real Wikipedia articles, snapshot ASTs,
    zero regressions
21. Round-trip invariant: `parse(stringify(parse(x))) deep= parse(x)` on
    full corpus
22. Extension construction-time specialization: verify hot loop has no per-event
    flag checks (review generated code or benchmark with/without extensions)

## Error Recovery

Wikitext has no "invalid" input — everything renders. The parser must produce
a tree for any input:
- Unclosed bold/italic → close at end of line (MediaWiki behavior)
- Unclosed `[[` or `{{` → treat as literal text
- Malformed tables → best-effort row/cell structure, fall back to text
- Unknown extension tags → opaque HtmlTag with raw content
- Mixed/nested list markers → build deepest sensible nesting
- Chunked input mid-token → carry buffer handles partial tokens across chunks
- Error events: optionally emit `{ type: "error", message, position }` events
  for recovery points (consumer can log or ignore)
