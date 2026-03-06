# Architecture

`@okikio/wikitext` is an event-stream-first wikitext source parser. It turns
wikitext markup into a structured event stream and, optionally, a unist-compatible
AST called "wikist" (Wiki Syntax Tree). The event stream is the fundamental
interchange format: every output mode (AST, HTML, filtered events, direct
callbacks) is a consumer of the same event pipeline.

This document describes the pipeline design, streaming modes, parser contracts,
extension model, and the design constraints that enable live editing overlays.

## Pipeline overview

The parser runs as a four-stage pipeline. Each stage is a generator that pulls
from the previous one, so the entire parse is lazy and single-pass from the
caller's perspective. All stages accept a `TextSource` (an abstraction over
strings, ropes, and CRDT text types) rather than a bare `string`.

```
TextSource
   │
   ▼
┌────────────┐  charCodeAt scanner
│ Tokenizer  │  Generator<Token>
│            │  offset-based tokens (no value strings)
└─────┬──────┘
      │
      ▼
┌──────────────┐  line-start dispatch
│ Block Parser │  enter/exit events for block structures
│              │  records state snapshots at boundaries
└─────┬────────┘
      │
      ▼
┌───────────────┐  recursive descent with explicit stack
│ Inline Parser │  enriches text events with inline markup
│               │  enter/exit for bold, links, templates, ...
└─────┬─────────┘
      │
      ▼
┌───────────┐
│ Consumers │
│           ├── buildTree()      → WikistRoot (AST)
│           ├── compileHtml()    → string (HTML)
│           ├── filterEvents()   → filtered event stream
│           └── direct callback  → user-defined handler
└───────────┘
```

Each stage can also be used independently:
- `tokens(input)` returns the raw token stream (cheapest path).
- `outlineEvents(input)` returns block-level events only (no inline parsing).
- `events(input)` returns the full event stream (block + inline).
- `parse(input)` is shorthand for `buildTree(events(input))`.


## Events as the interchange layer

The key architectural insight, drawn from micromark, pulldown-cmark, and
lol-html: events are more fundamental than trees. An event stream represents
the same structural information as an AST but without requiring tree allocation
upfront. Consumers choose how much structure to materialize.

An event is one of five variants. Events are **range-first**: text and token
events carry offset ranges into the source, not allocated strings. A
`slice(source, evt)` helper resolves the string on demand, matching the
discipline already used by raw tokens.

| Variant | Fields | Meaning |
|---------|--------|---------|
| `enter` | `node_type`, `props`, `position` | Opens a node |
| `exit`  | `node_type`, `position` | Closes the matching node |
| `text`  | `start_offset`, `end_offset`, `position` | Literal text range |
| `token` | `token_type`, `start_offset`, `end_offset`, `position` | Raw token range |
| `error` | `message`, `position` | Recovery diagnostic event |

Consumers that need the string value call `slice(source, event)`. This avoids
repeated substring allocations during streaming and incremental reparses, and
prevents memory retention hazards from keeping substrings alive.

Enter/exit pairs nest like parentheses. The event stream is always
well-formed: every `enter(X)` has a matching `exit(X)`, with proper stack
discipline. Consumers can rely on this for correct tree construction,
streaming HTML emission, and event filtering.


## Streaming modes

Three named modes cover the range of cost versus detail. All preserve event
well-formedness.

### Outline events (block-only)

```ts
function* outlineEvents(input: string): Generator<WikitextEvent>
```

Emits only block-level structure: headings, lists, tables, paragraphs. Inline
content stays as opaque text ranges. No inline parsing cost.

Use case: table of contents generation, section index, document structure
extraction.

### Full events

```ts
function* events(input: string): Generator<WikitextEvent>
```

Complete event stream with both block structure and inline markup (bold, italic,
links, templates, etc.). This is the default mode and the input to `buildTree()`.

### Progressive blocks (async)

```ts
async function* parseChunked(
  chunks: AsyncIterable<string>
): AsyncGenerator<WikistNode>
```

Yields completed block-level nodes as soon as their closing boundary arrives.
Each yielded node is a fully-parsed subtree (block + inline). Useful for
streaming rendering and progressive wiki preview.


## TextSource abstraction

All pipeline stages accept a `TextSource` rather than a bare `string`. This
decouples the parser from any specific text storage representation.

```ts
interface TextSource {
  /** Total length in UTF-16 code units. */
  readonly length: number;
  /** Return the substring from start (inclusive) to end (exclusive). */
  slice(start: number, end: number): string;
  /** Character code at the given UTF-16 offset. */
  charCodeAt(index: number): number;
  /** Optional: iterate slices for chunked operations. */
  iterSlices?(start: number, end: number): Iterable<string>;
}
```

A plain JS `string` satisfies this interface with zero adapter code. More
advanced backing stores can implement it:

- **Rope / piece table**: best for frequent edits (editor use case).
- **CRDT text type**: Yjs `Y.Text`, Automerge text (collaboration).
- **Append-only buffer**: LLM streaming output.

The tokenizer calls `source.charCodeAt(i)` in its hot loop, so the backing
store must make that operation cheap. For ropes, a cursor-based iterator that
amortizes node traversal works well.


## Session API

The stateless functions (`parse()`, `events()`, `outlineEvents()`) remain the
primary API. For live use cases (editors, streaming, collaboration), the
`Session` provides a stateful wrapper that caches parse state and supports
incremental updates.

```ts
const session = createSession(source);

// Stateless-equivalent (delegates to pipeline)
session.events();        // full event stream
session.outline();       // block-only events (cheap structural overlay)
session.parse();         // full AST

// Streaming
session.write(chunk);          // append-only streaming input
session.drainStableEvents();   // stable prefix events only

// Editing (incremental)
const result = session.applyChanges(edits);  // incremental reparse
result.positionMap;   // old-offset → new-offset mapping
```

Session is built *on top of* the pipeline, not replacing it. Each tier adds
capability without retroactive redesign:

- **Core**: `createSession(source)` with `.events()`, `.outline()`,
  `.parse()`. Caches the last parse result.
- **Streaming**: `.write(chunk)` for append-only streaming,
  `.drainStableEvents()` for stable prefix consumption.
- **Incremental**: `.applyChanges(edits)` with incremental reparse, edit
  coalescing, and `PositionMap` return.


## Stability frontier (streaming)

When parsing streamed input (LLM output, network data, progressive loading),
the document splits into two regions:

```
┌──────────────────────────┬──────────────────────┐
│     Stable prefix        │  Provisional tail    │
│  (safe to render with    │  (may change when    │
│   full structure)        │   delimiters close)  │
└──────────────────────────┴──────────────────────┘
                           ▲
                    stability frontier
```

The **stability frontier** is the offset up to which the parser is confident
that events will not be invalidated by future input. Content before the
frontier can be rendered with full structure. Content after the frontier is
provisional: open `{{`, `[[`, `{|`, or `<ref>` delimiters may still close.

The session maintains this frontier and exposes two drain channels:

- **Stable events**: guaranteed not to be invalidated by future input.
- **Provisional tail events**: best-effort parse of incomplete content. May be
  replaced when more input arrives.

**Replacement semantics (Model A, two channels with tail reset):** when new
input moves the stability frontier forward, the session emits a `tail-reset`
marker followed by re-emitted events for the new provisional tail. Consumers
that rendered the previous provisional tail discard it and re-render from the
new tail events. Stable events are append-only and never revoked. This model
keeps consumer logic simple: stable events are committed, provisional events
are always replaceable as a unit.

(Alternative Model B, a "patch stream" where the session emits fine-grained
insert/delete/replace ops on the previous provisional events, trades consumer
simplicity for bandwidth efficiency. If Model A proves too expensive for large
provisional tails, Model B is the fallback. Defer the choice until streaming
implementation.)

This is essential for smooth streaming UIs. Without a stability frontier, each
new chunk could invalidate the entire parse.


## Parser contracts

Four invariants that every API path must satisfy. These constrain every
implementation decision.

### 1. Event well-formedness (stack discipline)

Every `enter(X)` has a matching `exit(X)`. Events form a properly nested stack.
No interleaving, no orphaned exits. At any point in the event stream, the
sequence of enter/exit events forms a valid prefix of a well-parenthesized
string.

### 2. Position semantics (UTF-16 code unit offsets)

`position.offset` is a UTF-16 code unit index into the original JS input
string. This matches `string.charCodeAt(i)`, `string[i]`, and `string.slice()`.

- `line` is 1-indexed (first line = 1).
- `column` is 1-indexed, counting UTF-16 code units from start of line.
- `offset` is 0-indexed, counting UTF-16 code units from start of input.

This aligns with LSP position semantics (`utf-16` encoding mode). Since
LSP 3.17, clients and servers can negotiate other position encodings (UTF-8,
UTF-32), but UTF-16 support remains mandatory for backwards compatibility.
Wikist stores UTF-16 offsets natively; an adapter layer translates if a client
negotiates a different encoding. This choice avoids subtle bugs with non-ASCII
content (CJK articles, diacritics, emoji).

### 3. Never-throw guarantee

The parser never throws on any input. Malformed wikitext produces a valid
wikist tree with error recovery. Recovery points optionally emit
`{ kind: "error", message, position, ...diagnosticMetadata }` events that
consumers can log or ignore.

### 4. Determinism

Same input + same config produces the same events, the same tree. No randomness,
no dependency on global state. This enables snapshot testing, round-trip
invariants, and reproducible corpus regression.

### 5. Cross-mode consistency

The three streaming modes (`outlineEvents`, `events`, `parse`) must agree on
block-level structure. If `outlineEvents` emits `enter("heading")` for a range,
then `events` for the same input must also emit `enter("heading")` for that
range, and `parse` must produce a `Heading` node covering it. An outline saying
"heading" while the full parse says "paragraph" is a bug.

This constraint exists because `outlineEvents` is meant as a cheap structural
overlay. Consumers may use it for table of contents or section indexing, then
switch to `events` for full inline detail. Structural disagreement between
modes breaks that layering. The test suite must include cross-mode consistency
checks: for every test input, block-level events from `outlineEvents` must be
a subset of those from `events`.


## Token design

Tokens carry start/end offsets into the `TextSource`, not value strings. A
`slice(source, token)` helper resolves the string on demand. This avoids
per-token allocation and sidesteps V8's sliced-string retention risk: a small
slice *can* pin the entire parent string in memory (the behavior is
heuristic-driven in V8, not unconditional, but offset-based tokens avoid the
risk entirely).

```ts
interface Token {
  type: TokenType;
  start: number;   // UTF-16 code unit offset into TextSource
  end: number;     // exclusive end
}
```

Events follow the same discipline: `text` and `token` events carry offset
ranges, not string values. The `slice(source, event)` helper works for both
tokens and events.

The tokenizer calls `source.charCodeAt(i)` in its hot loop: no string
allocation per character, no closures in the inner loop, JIT-friendly tight
switch on character codes.


## Block parser design

The block parser consumes tokens and emits block-level events. It is
line-oriented: the first token(s) of each line determine the block type.

```
=          → Heading
* # : ;    → List / DefinitionList
{|         → Table
----       → ThematicBreak
(space)    → Preformatted
(other)    → Paragraph
```

At each block boundary, the parser records a compact **state snapshot**:
`{ inNowiki, inPre, openTagStack, openTemplateDepth, inTable }`. These
snapshots enable incremental reparsing by identifying the nearest
"neutral boundary" (all stacks empty) when an edit occurs.

**Neutral boundary definition**: a neutral boundary is a position where ALL
of the following tracked parser state is at its default (empty/zero) value:
- `openTemplateDepth` = 0: no open `{{` awaiting `}}`
- `openLinkDepth` = 0: no open `[[` awaiting `]]`
- `inTable` = false: not inside `{| ... |}`
- `openTagStack` = []: no open HTML tags
- `inNowiki` = false: not inside `<nowiki>` or `<pre>`
- quote state = clean: no unresolved apostrophe runs

At a neutral boundary, parsing can resume from scratch without inheriting any
state from prior content. This is what makes incremental reparsing safe:
identify the nearest neutral boundary before the edited range, reparse from
there, and splice the new events into the existing stream.


## Inline parser design

The inline parser enriches block events by expanding text events into
finer-grained enter/exit/text events for inline markup. It uses recursive
descent with an explicit stack.

Key algorithms:
- **Apostrophe disambiguation**: 2 = italic, 3 = bold, 5 = bold+italic.
  Unclosed runs close at end of line.
- **Link detection**: `[[target|display]]` with namespace dispatch
  (File/Image → `ImageLink`, Category → `CategoryLink`). A leading colon
  (`[[:Category:Foo]]`, `[[:File:Foo.png]]`) overrides namespace dispatch:
  the result is a `Wikilink` (visible link), not `ImageLink`/`CategoryLink`.
- **Template parsing**: `{{name|args}}` with named/positional arguments.
  Triple braces `{{{param}}}` are `Argument` nodes. `{{#if:...}}` are
  `ParserFunction` (identified by `#` prefix). Variable-style magic words
  (`{{PAGENAME}}`) parse as `Template` by default; profiles reclassify.


## Error recovery

Wikitext has no "invalid" input. Everything renders in MediaWiki, so the parser
produces a tree for any input. Recovery strategies:

| Malformed input | Recovery |
|-----------------|----------|
| Unclosed bold/italic | Close at end of line |
| Unclosed `[[` or `{{` | Treat opening as literal text |
| Malformed tables | Best-effort row/cell, fall back to text |
| Unknown extension tags | Opaque `HtmlTag` with raw content |
| Mixed/nested list markers | Build deepest sensible nesting |


## Incremental reparsing

Goal: reparse only the affected region after an edit.

1. Find affected blocks via source range overlap with the edit.
2. Walk backward to the nearest block boundary with a neutral state snapshot
   (all stacks empty). This catches cross-block spans like `{{ ... \n ... }}`.
3. Re-tokenize from the neutral boundary through the dirty range.
4. Re-parse affected blocks. Compare new block-start sequence to old; expand
   dirty range if structural boundaries shifted.
5. Splice new blocks into old tree, reuse untouched subtrees by reference.

State snapshots recorded during the initial parse make this possible without
full reparse.

### Edit interface and PositionMap

Edits are described as:

```ts
interface Edit {
  offset: number;       // UTF-16 code unit offset
  deleteCount: number;  // code units to remove
  insertText: string;   // replacement text
}
```

`session.applyChanges(edits)` accepts a batch of edits. Close edits are
coalesced into one reparse window when safe (collaboration engines emit many
tiny operations). The return value includes a `PositionMap` that maps
"before" offsets to "after" offsets, preserving cursor positions, selections,
and comment anchors across edits.


## Extension model

Extensions do not touch the tokenizer hot loop. The model has two layers:

1. **Construction-time specialization**: feature gates produce a specialized
   parser instance with baked-in token dispatch and event handler tables. No
   per-character flag checks at runtime.

2. **Event enrichment passes**: extensions run after the core pipeline.
   - **Tag handlers**: `registerTagHandler(tagName, handler)` for custom
     behavior on extension tags (`<ref>`, `<math>`, `<graph>`).
   - **Template resolver**: optional hook for template expansion.
   - **Feature gates**: `{ tables: true, templates: true, htmlTags: true }`.

### Profiles

A profile is a named bundle of feature gates and ambiguity resolution rules.
Profiles are sugar over the construction-time config, not a separate pipeline.

- `syntax` (default): deterministic structural parse with clean recovery.
- `mediawiki`: matches MediaWiki's exact parsing behavior for
  ambiguous constructs.


## Hybrid editing overlay (design constraint)

The parser is not an editor, but its APIs must make a good editor possible.
The target editing model is a hybrid between text-first and block-first:

- **Typing remains text-native.** The underlying buffer is a text string (or
  `TextSource`). Selection, copy/paste, and undo operate on text.
- **Structure is a live overlay.** The outline and full event streams drive
  layout effects (decorations, widgets) without requiring block-first storage.
- **Markup hiding is local.** Editors hide wikitext syntax except near the
  cursor. This requires stable, range-based structure from the parser so the
  editor can "expand" markup at the cursor position without reflowing the
  entire document.
- **Inline parsing can be lazy.** Outside the viewport or cursor neighborhood,
  inline content stays as opaque text ranges (via `outlineEvents()` or
  `buildTree({ inlineMode: "lazy" })`). `resolveInlines(node)` parses
  on demand.
- **Reflow must be bounded.** Every keystroke triggers at most a local
  incremental reparse, not a global re-render. `outlineEvents()` is
  always cheap.

This pattern appears in real systems like Typora, Obsidian Live Preview, and
CodeMirror rich-editing plugins. The common failure mode is cursor jumps and
line shifting when the system hides or reveals syntax. The fix is surgical:
only transform where it is safe and stable, and be conservative elsewhere.

The parser supports this pattern by providing:
- `outlineEvents()` as the cheap structural overlay (always available)
- Lazy inline parsing (resolve on demand, not eagerly)
- Incremental reparsing with bounded dirty ranges
- Stability frontier for streaming (stable prefix vs. provisional tail)
- `PositionMap` for mapping cursor/selection offsets across edits


## File layout

Flat files at root alongside `mod.ts`. No `src/` folder.

| File | Role |
|------|------|
| `ast.ts` | Wikist node types, type guards, builders |
| `events.ts` | `WikitextEvent` union, constructors |
| `token.ts` | `Token` interface, `TokenType` const-object |
| `tokenizer.ts` | Generator-based scanner |
| `block_parser.ts` | Block-level event emitter |
| `inline_parser.ts` | Inline event enrichment |
| `parse.ts` | Orchestration (tokenize → block → inline → tree) |
| `tree_builder.ts` | `buildTree(events) → WikistRoot` |
| `stringify.ts` | AST → wikitext (round-trip) |
| `filter.ts` | Filter/visit for tree and event streams |
| `mod.ts` | Re-exports all public APIs |
| `text_source.ts` | `TextSource` interface and string adapter |
| `session.ts` | `createSession()` stateful API |

Advanced modules (planned): `async_tokenizer.ts`, `push_parser.ts`,
`incremental.ts`, `compile_html.ts`, `extensions.ts`, `unified.ts`.
