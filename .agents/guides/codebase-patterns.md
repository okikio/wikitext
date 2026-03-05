# Codebase Patterns: Wikitext Parser

Reference for the key architecture, data flow, and internal patterns.
Read this before making any non-trivial change to core modules.

## Pipeline architecture

Events, not AST, are the fundamental output. Everything else is a consumer.
The pipeline accepts any `TextSource` (plain `string` satisfies the interface).

```
TextSource ─► Tokenizer ─► Block Parser ─► Inline Parser ─► [Consumer]
                 │               │               │                │
                 │  charCodeAt   │  line-start   │  recursive     ├─► buildTree()
                 │  scanner      │  dispatch     │  descent       ├─► compileHtml()
                 │               │               │  with stack    ├─► filterEvents()
                 │               │               │                └─► direct callback
                 │               │               │
                 │               │               └─► text events enriched with
                 │               │                   inline enter/exit pairs
                 │               │
                 │               └─► block enter/exit events
                 │                   + state snapshots at boundaries
                 │
                 └─► Generator<Token> (offset-based, no value strings)
```

Three streaming modes, all event-well-formed (stack discipline):

| Mode | API | Cost | Use case |
|------|-----|------|----------|
| Outline | `outlineEvents(input)` | Block only | TOC, section index |
| Full | `events(input)` | Block + inline | Default, tree building |
| Progressive | `parseChunked(chunks)` | Async block nodes | Streaming render |

All event modes produce **range-first events**: text/token events carry
`start_offset`/`end_offset` into the `TextSource` rather than an extracted
`value` string. Consumers call `slice(source, evt)` to resolve text on demand.

## TextSource (`text_source.ts`)

Minimal interface that abstracts the backing text store:

```ts
interface TextSource {
  readonly length: number;
  charCodeAt(index: number): number;
  slice(start: number, end: number): string;
  iterSlices?(start: number, end: number): Iterable<string>; // optional
}
```

Plain `string` satisfies this interface. Rope trees, CRDTs (Yjs `Y.Text`),
and append buffers can implement it for zero-copy access.

The tokenizer and all downstream modules accept `TextSource`, not bare `string`.
This is the collaboration-readiness seam: swapping the backing store does not
require changing any parser module.

## Tokenizer (`tokenizer.ts`)

Generator-based scanner using `charCodeAt` on the `TextSource`. Yields
`Token` objects with offset ranges, never value strings.

### Token design (offset-based)

```ts
interface Token {
  type: TokenType;
  start: number;   // UTF-16 code unit offset into TextSource
  end: number;     // exclusive end offset
  // No `value` field: use slice(source, token) to resolve on demand
}
```

Why offsets instead of value strings:
- Avoids per-token string allocation
- Sidesteps V8's sliced-string retention risk (small slice *can* pin entire
  parent string; behavior is heuristic-driven, not unconditional)
- Consumer calls `slice(source, token)` only when it needs the text
- Works identically with `TextSource` implementations that aren't `string`

### Character code constants

Hot scanning loops use integer character codes:

| Constant         | Hex    | Character | Wikitext role |
|------------------|--------|-----------|---------------|
| `CC_EQUALS`      | `0x3d` | `=`       | Heading marker, template arg |
| `CC_APOSTROPHE`  | `0x27` | `'`       | Bold/italic delimiter |
| `CC_OPEN_BRACKET`| `0x5b` | `[`       | Link open |
| `CC_CLOSE_BRACKET`| `0x5d` | `]`      | Link close |
| `CC_OPEN_BRACE`  | `0x7b` | `{`       | Template/table open |
| `CC_CLOSE_BRACE` | `0x7d` | `}`       | Template/table close |
| `CC_PIPE`        | `0x7c` | `\|`      | Table cell, template arg |
| `CC_BANG`        | `0x21` | `!`       | Table header cell |
| `CC_ASTERISK`    | `0x2a` | `*`       | Bullet list marker |
| `CC_HASH`        | `0x23` | `#`       | Ordered list marker |
| `CC_COLON`       | `0x3a` | `:`       | Definition description / indent |
| `CC_SEMICOLON`   | `0x3b` | `;`       | Definition term |
| `CC_DASH`        | `0x2d` | `-`       | Thematic break (`----`) |
| `CC_TILDE`       | `0x7e` | `~`       | Signature (`~~~`+) |
| `CC_UNDERSCORE`  | `0x5f` | `_`       | Behavior switch (`__TOC__`) |
| `CC_LT`         | `0x3c` | `<`       | HTML/extension tag, comment |
| `CC_GT`         | `0x3e` | `>`       | HTML tag close |
| `CC_AMP`        | `0x26` | `&`       | HTML entity |
| `CC_LF`         | `0x0a` | `\n`      | Line ending |
| `CC_CR`         | `0x0d` | `\r`      | Carriage return |
| `CC_SPACE`      | `0x20` | ` `       | Whitespace, preformatted line |
| `CC_TAB`        | `0x09` | `\t`      | Whitespace |

### Scanning rules

- **Single pass**: never backtracks more than bounded lookahead
  (max 4 chars: `<!--` for comment open)
- **Line-start markers** only recognized at start of line (after optional
  whitespace): `=`, `*`, `#`, `:`, `;`, `{|`, `|-`, `|}`, `----`, ` `
- **Apostrophe runs** emitted as single `APOSTROPHE_RUN(length)` token;
  disambiguation deferred to inline parser
- **Comment/nowiki regions** pre-scanned to protect content from tokenization
- **Fresh objects per yield**: no object reuse across generator yields

## Block parser (`block_parser.ts`)

Consumes token stream, emits block-level enter/exit/text events.
Line-oriented dispatch:

```
First token(s) of line → block type:
  =          → Heading (count determines level)
  * # : ;    → List/ListItem/DefinitionList
  {|         → Table
  ----       → ThematicBreak
  (space)    → Preformatted
  (other)    → Paragraph
```

Block nesting rules:
- `***` = 3-deep bullet list → nested `enter(list) → enter(listItem)` chain
- `; term : desc` → DefinitionList with DT/DD events
- Tables: `{|` opens, `|}` closes, `|-` = row, `!` = header, `|` = data,
  `|+` = caption
- Explicit stack for nested structures (lists in lists, tables in tables)

### State snapshots

At each block boundary, record:
`{ inNowiki, inPre, openTagStack, openTemplateDepth, inTable }`

Enables incremental reparsing (Phase 7) to find the nearest "neutral
boundary" when determining where to start reparsing after an edit.

**Neutral boundary**: a position where all tracked parser state is at its
default (empty/zero) value: `openTemplateDepth` = 0, `openLinkDepth` = 0,
`inTable` = false, `openTagStack` = [], `inNowiki` = false, quote state
clean. Parsing can resume from scratch at a neutral boundary without
inheriting state from prior content.

## Inline parser (`inline_parser.ts`)

Enriches block events with inline markup. Recursive descent with explicit
stack for nesting.

### Key algorithms

**Apostrophe run disambiguation:**
- 2 = italic, 3 = bold, 5 = bold+italic
- 4 = one literal apostrophe + bold
- Unclosed runs → close at end of line (MediaWiki behavior)

**Link detection:**
- `[[target|display]]` → Wikilink
- `[[File:...]]` / `[[Image:...]]` → ImageLink
- `[[Category:...]]` → CategoryLink
- `[[:Category:Foo]]` / `[[:File:Foo.png]]` → Wikilink (leading-colon
  escape: visible link, not assignment/embed)
- `[url text]` and bare URLs → ExternalLink
- Nested `[[` inside template args handled by bracket counting

**Template parsing:**
- `{{name|arg1|key=value}}` → Template + TemplateArgument events
- `{{#if:...}}` → ParserFunction (identified by `#` prefix)
- `{{PAGENAME}}` → Template by default (variable-style magic words are
  a configured set; profiles or consumers reclassify known names)
- `{{{param|default}}}` → Argument (triple braces)
- Cross-block spans possible (`{{ ... \n ... }}`)

**HTML tags:**
- Self-closing, void elements, matching open/close pairs
- Extension tags (`<ref>`, `<nowiki>`, `<pre>`, etc.): content protected

**Special constructs:**
- `~~~`/`~~~~`/`~~~~~` → Signature
- `__TOC__`, `__NOTOC__` → BehaviorSwitch
- `#REDIRECT [[...]]` → Redirect
- `&amp;` → HtmlEntity

## Tree builder (`tree_builder.ts`)

`buildTree(events) → WikistRoot`

Consumes the event stream, produces a wikist tree (unist-compatible AST).
Every `enter` pushes onto a stack, every `exit` pops and attaches to parent.
`text` events become `Text` leaf nodes.

Supports `{ inlineMode: "lazy" }`: inline content stays as `Text` nodes
until `resolveInlines(node)` is called on demand.

## Position semantics

All positions use UTF-16 code unit offsets (matching JS string indexing):

- `line`: 1-indexed (first line = 1)
- `column`: 1-indexed, UTF-16 code units from start of line
- `offset`: 0-indexed, UTF-16 code units from start of input
- `input.slice(start.offset, end.offset)` returns the source text

## Error recovery

The parser never throws on any input:

| Malformed input | Recovery |
|-----------------|----------|
| Unclosed bold/italic | Close at end of line |
| Unclosed `[[` or `{{` | Treat opening as literal text |
| Malformed tables | Best-effort row/cell, fall back to text |
| Unknown extension tags | Opaque `HtmlTag` with raw content |
| Mixed/nested list markers | Build deepest sensible nesting |
| Chunked input mid-token | Carry buffer handles partial tokens |

Optionally emit `{ type: "error", message, position }` events for recovery
points that consumers can log or ignore.

## Performance discipline

- `charCodeAt`, not `charAt`: avoid string allocation per character
- Offset-based tokens, not value strings: avoid per-token allocation
- Range-first events: no `value` strings on text events
- Single-pass scanning with bounded lookahead
- Fresh immutable objects per yield: no object reuse across generator yields
- JIT-friendly hot loops: no megamorphic call sites, no closures per character
- No closures allocated in inner loops

## Session API (`session.ts`)

Stateful wrapper around the stateless pipeline. Surface area grows across
phases:

| Phase | Surface |
|-------|---------|
| 5 | `createSession(source)` → `.events()`, `.outline()`, `.parse()` |
| 6 | `.write(chunk)`, `.drainStableEvents()` |
| 7 | `.applyChanges(edits)` → `PositionMap`, edit coalescing |

Session delegates to pipeline modules and caches parse state. It is not a
God object; each phase adds minimal API surface.

### Stability frontier

During streaming (Phase 6), the Session tracks a `stabilityOffset`: the
UTF-16 offset up to which emitted events are guaranteed stable. Events
before the frontier won't change as more input arrives. Events after are
provisional.

```
[───── stable prefix ──────][── provisional tail ──]
                              ▲
                       stabilityOffset
```

### PositionMap

Returned by `session.applyChanges(edits)`. Maps old-offset → new-offset,
enabling callers (editors, annotation layers) to translate positions across
edits without re-parsing the full tree.

## File layout

Flat files at root alongside `mod.ts`. No `src/` folder.

| File | Role |
|------|------|
| `ast.ts` | Wikist node types, type guards, builders |
| `events.ts` | `WikitextEvent` union, constructors |
| `token.ts` | `Token` interface, `TokenType` enum |
| `text_source.ts` | `TextSource` interface |
| `tokenizer.ts` | Generator-based scanner |
| `block_parser.ts` | Block-level event emitter |
| `inline_parser.ts` | Inline event enrichment |
| `parse.ts` | Orchestration (tokenize → block → inline → tree) |
| `tree_builder.ts` | `buildTree(events) → WikistRoot` |
| `session.ts` | Stateful `Session` wrapper (Phases 5–7) |
| `stringify.ts` | AST → wikitext (round-trip) |
| `filter.ts` | Filter/visit for tree and event streams |
| `mod.ts` | Re-exports all public APIs |

For the current full public API, run `deno doc mod.ts` or read the exports at
the top of `mod.ts` directly. Duplicating that list here would only drift.
