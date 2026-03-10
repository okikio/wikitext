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
- `parse(input)` is shorthand for `buildTree(events(input), { source: input })`.
- `parseWithDiagnostics(input)` keeps a more conservative tree plus recovery diagnostics.
- `parseWithRecovery(input)` keeps the more aggressively recovered tree plus an explicit recovery flag and diagnostics.

The extra `source` argument on `buildTree()` exists because the event stream is
range-first. Text events carry offsets, not copied strings, so the tree
builder needs the original source to materialize `Text.value`.

This means the parser's tolerance and the caller's result shape are separate
choices. The parser still upholds its never-throw contract, but callers can
choose whether they want only the forgiving recovered tree, a more
conservative tree plus diagnostics, or the recovered tree plus diagnostics and
an explicit recovery summary.

Today, the lower-level pieces are the part that already exists in the codebase:
`TextSource`, tokens, events, AST node types/builders/guards, `tokenize()`,
`blockEvents()`, and `inlineEvents()`. The orchestration helpers listed above
describe the intended top-level API shape, but some of them are still future
work rather than shipped exports.


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


## Public export boundary

The package aims to be utility-first, but not implementation-detail-first.

That means these categories are deliberately public:

- source abstractions such as `TextSource`
- token, event, and AST interfaces
- discriminated unions and category aliases used in downstream narrowing
- builder functions and type guards
- parser stage entry points such as `tokenize()`, `blockEvents()`, and `inlineEvents()`

These categories are still intentionally internal:

- parser-stage local context records
- temporary matcher result objects
- low-level scan helpers whose contracts are tuned for one implementation

This split keeps the package practical for tool authors who want to build on
top of the parser, while avoiding a large accidental API surface that would
freeze internal recovery and performance machinery too early.


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

## Fixed-vocabulary lookups

Some parser decisions are true control-flow dispatch, so they stay as normal
`switch` statements. Other checks are simpler: the code only needs to answer
"is this one of our known markers?" or "what predeclared value does this token
type map to?"

Those fixed-vocabulary cases now prefer null-prototype object lookups in a few
hot spots. That is a performance optimization, not a semantic requirement.

```text
normal object lookup
  own key?                yes -> match
  no -> walk prototype chain -> inherited key may exist

null-prototype lookup
  own key?                yes -> match
  no -> stop
```

`Object.create(null)` removes inherited keys such as `toString` and
`constructor`, so the table behaves more like a bare dictionary. Then
`Object.hasOwn(table, key)` makes the intent explicit: only entries declared in
that table count. This works well for fixed token-type and marker vocabularies
where the parser wants cheap repeated membership or value-map checks without
building dynamic collections.


## Tree materialization

`buildTree(events, { source })` converts the event stream into a wikist object
graph. The parser itself stays event-first. Tree building is a consumer step
for callers that want random-access traversal.

`buildTreeWithDiagnostics(events, { source })` runs the same materialization,
but it also preserves recovery diagnostics that would otherwise disappear once
the tree has been built.

`buildTreeWithRecovery(events, { source })` adds one more summary field,
`recovered`, for consumers that want to branch explicitly on whether any
recovery happened while building the final tree.

The conversion rule is intentionally mechanical:

```text
event stream (simplified)
  enter(root)
  enter(paragraph)
  text(0, 5)
  exit(paragraph)
  exit(root)

tree
  root
  └─ paragraph
     └─ text "hello"
```

Two concrete details matter for correctness and caller expectations.

1. Root events are document boundaries, not nested root children.
2. Text node values are materialized from source offsets, so `buildTree()`
   requires the original source input.

### Why `source` is required by `buildTree`

The event stream is range-first. A text event carries offsets and position, not
copied string content. Tree construction resolves that range on demand:

```text
text event range + source input -> Text.value
```

Without `source`, `buildTree()` could still build structural shape, but it
could not materialize `Text.value` correctly.

### Recovery behavior for malformed event streams

`buildTree()` is defensive. It does not assume enter and exit events are always
perfectly ordered.

Case A, out-of-order exits:

```text
enter(paragraph)
enter(bold)
exit(paragraph)
```

Recovery action:

```text
close bold at the reported paragraph end
close paragraph
```

Case B, stream ends with open frames:

```text
enter(paragraph)
text(...)
EOF
```

Recovery action:

```text
auto-close paragraph using its last known end point
```

`token` and `error` events are ignored for AST shape. They stay valuable in the
event layer for diagnostics and tooling, but the current wikist tree model does
not represent them as tree nodes.

Instead, the diagnostics-preserving APIs keep them alongside the tree:

```text
ParseResult
  ├─ tree: WikistRoot
  └─ diagnostics: ParseDiagnostic[]
```

Each diagnostic carries an `anchor` to the nearest active node at the time of
recovery, so downstream tools can locate the relevant region in the final tree
without turning parser diagnostics into normal AST children.

Today that anchor is a narrow tree-path snapshot. It resolves against one final
materialized tree only. Edit-stable anchor identity, slot semantics, and other
cross-edit guarantees stay out of the public API until session edit tracking
exists.

The consumer-side helper pair is:

```text
resolveDiagnosticAnchor(tree, diagnostic.anchor)
locateDiagnostic(tree, diagnostic)
```

Those helpers turn the stored child-index path back into a concrete node,
parent, and index, so editor and lint tooling can react without reimplementing
tree walking logic.


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
session.parseWithDiagnostics(); // full AST + recovery diagnostics

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
  `.parse()`, and `.parseWithDiagnostics()`. Caches the last parse result.
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

At each block boundary, the parser will record a compact **state snapshot**:
`{ inNowiki, inPre, openTagStack, openTemplateDepth, inTable }`. These
snapshots will enable incremental reparsing by identifying the nearest
"neutral boundary" (all stacks empty) when an edit occurs. State snapshot
recording is deferred to later; the insertion point is marked with a
`TODO` comment in `block_parser.ts`.

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

### HTML-like tag recovery boundary

HTML-like and extension-like tags use one deliberate recognition boundary: the
closing `>` of the opener.

Read the policy like this:

```text
before `>`  -> opener is still unresolved, keep source as text
after `>`   -> opener is structurally real, recover as a tag if later balancing breaks
```

That means three different cases behave differently.

```text
<ref foo<div>>body</ref>
  -> opener closed with `>`
  -> malformed attributes are tolerated
  -> tag is recognized

<ref name="x"
  -> opener never reached `>`
  -> emit an inline recovery diagnostic
  -> preserve the original source as text

<ref name="x">body
  -> opener is real because `>` was reached
  -> emit an inline recovery diagnostic for the missing close tag
  -> keep the reference node and recover it to the end of the current text range
```

This is intentionally closer to HTML's permissive tag-tokenization spirit than
to strict validation, but it is not a browser-DOM emulation. The parser does
not commit to a tag node until the opener is syntactically closed with `>`.
After that point, later breakage is treated as structural recovery, not as a
reason to discard the opener and fall back to plain text.

## Why the current perf boosts are shaped this way

The recent parser performance work is not trying to make the parser less
correct in exchange for speed. It is trying to remove repeated work that did
not add new information.

The easiest place to see that is the handoff from the block parser to the
inline parser.

Before the optimization, one paragraph like this:

```text
Hello [[Mars|planet]] world
```

could arrive at the inline parser as many small neighboring text events, each
covering only one tokenizer-sized chunk. The inline parser then had to merge
those neighboring events back together before it could even start looking for
real inline syntax.

That meant the pipeline was doing this:

```text
token stream
  -> block parser emits many adjacent text ranges
  -> inline parser merges them back into one logical text group
  -> inline parser finally scans for [[, {{, '', <tag>, and so on
```

The newer block-parser optimization changes that handoff to this:

```text
token stream
  -> block parser coalesces contiguous text into one larger source range
  -> inline parser receives the already-merged text group
  -> inline parser scans directly for real inline syntax
```

The important point is that both versions describe the same source bytes. The
optimization removes redundant splitting and re-merging. It does not change the
intended source coverage of the text range.

That is why the change is compatible with the parser's range-first design. The
contract is "text events point at the correct source range," not "text events
must preserve tokenizer-sized boundaries."

### What this optimization actually saves

It saves three concrete kinds of work:

1. Fewer text event objects at the block stage.
2. Less array churn while the inline parser rebuilds logical text groups.
3. Less per-token overhead in prose-heavy input where most bytes are ordinary
   text and only a minority start real inline constructs.

That matters most on article-sized input, where the dominant cost is often not
the rare `[[` or `{{` opener itself, but the repeated work done around long
runs of plain text.

### Why the inline fast path is safe

The inline parser also has a fast path for merged text groups that contain no
possible inline opener at all.

In plain English, that fast path says:

```text
if this whole text group contains no `[[`, `{{`, `''`, `<`, `&`, `__`, `~~~`,
or bare-url opener,
then do not build extra line tables and do not rescan the group character by
character just to emit the same text range again.
```

That shortcut is safe because the block parser has already decided the exact
source range that belongs to the block. When there is no possible inline opener
inside that range, the inline parser would otherwise spend time reconstructing
positions for an output that stays plain text.

### One concrete handoff walkthrough

The easiest way to make the block-to-inline handoff less abstract is to follow
one real line of source through it.

Start with this paragraph line:

```text
Hello [[Mars|planet]] world
```

At the block stage, the important question is only "which source bytes belong
to this paragraph line?" The block parser does not decide what `[[Mars|planet]]`
means yet. It just emits text ranges that cover the right bytes.

In the older, more fragmented shape, that line could reach the inline parser as
several neighboring text events. In the newer shape, the block parser hands the
inline parser one already-merged text range for the whole line:

```text
block parser output
  text("Hello [[Mars|planet]] world")
```

The inline parser then scans inside that one range from left to right:

```text
source: "Hello [[Mars|planet]] world"

plain text before opener: "Hello "
inline opener:            "[["
inline construct:         "[[Mars|planet]]"
plain text after link:    " world"
```

That scan does not emit text character by character. It holds onto a pending
plain-text start offset, keeps moving forward, and only emits a plain-text
event when it must split around a real inline construct.

In other words, the inline parser behaves more like this:

```text
remember plain_start at the beginning
scan until a real opener appears
flush text before the opener
emit events for the inline construct
resume scanning after it
flush any trailing plain text at the end
```

That is what "deferred plain-text emission" means here. The parser delays the
plain-text event until it knows where the plain run actually ends.

### Why the block parser still splits paragraph text at physical newlines

This is the natural follow-up question:

```text
If two neighboring paragraph lines have no block markup of their own,
why not send the whole multi-line paragraph to the inline parser as one range?
```

The short answer is: the current handoff format uses contiguous source ranges,
but paragraph continuation newlines are treated as block-side structure rather
than inline text.

Take this paragraph:

```text
Alpha beta
Gamma delta
```

In raw source offsets, that is not one continuous "text without separators"
range. It is:

```text
[Alpha beta][\n][Gamma delta]
```

The current block parser intentionally treats that newline as a paragraph-line
boundary. It keeps the paragraph node open across both lines, but it does not
emit the newline itself as a `text` event. So the handoff today is effectively:

```text
enter("paragraph")
  text("Alpha beta")
  text("Gamma delta")
exit("paragraph")
```

That means the split is not only about the inline parser's scanning ability.
The inline parser can already scan across multiple lines when a text group
contains them. The deeper issue is representational:

1. A single `text` event currently means one contiguous source slice.
2. The bytes between the two paragraph lines include a real newline.
3. That newline is currently structural at the block stage, not emitted as
  inline text.

So if the block parser tried to collapse the two lines into one ordinary text
event, it would have to do one of two undesirable things:

1. Include the newline inside the text range, which would change today's event
  meaning.
2. Pretend `[Alpha beta]` and `[Gamma delta]` are one contiguous slice even
  though they are not.

That is why the parser currently splits at physical line boundaries even when
both lines belong to the same paragraph.

There is a possible future optimization here, but it would need a different
handoff shape, not just a small local tweak. For example, the block-to-inline
boundary could carry a discontiguous text group such as:

```text
paragraph text group
  - [start of line 1, end of line 1)
  - [start of line 2, end of line 2)
```

That would let the inline parser scan one logical paragraph payload without
being told that the newline itself is plain text. But that is a different
contract from the current `text(start_offset, end_offset)` event model.

So the current line-by-line split is mostly a contract choice, not proof that
the inline parser needs one line at a time. It is preserving two existing rules
at once:

- text events point at contiguous source slices
- continuation newlines inside paragraphs are structural separators, not text

### How positions are rebuilt without a point per character

The inline parser still needs precise positions for the events it emits, but it
does not store a full `{ line, column, offset }` point for every offset in the
merged text range.

Instead, it stores only the offsets where each line begins.

Example:

```text
source: "Hello\n[[Mars]]"
offsets: 01234567890123

line starts: [0, 6]
```

That means:

- line 1 starts at offset 0
- line 2 starts at offset 6

Later, if the inline parser needs the point for offset 9, it looks for the most
recent line start at or before 9. That is 6, so offset 9 becomes line 2,
column 4.

This is the reason the current position work is expensive but not completely
wasteful. The parser avoids one point object per code unit, but it still pays
to build the final nested `position.start` and `position.end` objects for every
event it emits.

### The correctness boundary the perf work must not cross

These optimizations only stay valid while they preserve source fidelity.

That means:

- they may merge adjacent text ranges
- they may skip redundant rescans
- they may avoid temporary arrays or closures

But they must not:

- trim real user content that still belongs to the block
- rewrite spacing inside ordinary text ranges
- invent or remove structural boundaries such as table-cell separators
- make block parsing depend on inline meaning

Preformatted lines are the clearest example. After the leading preformatted
marker space, trailing spaces are still real content. A performance change that
silently drops those spaces is not an optimization. It is a behavior change.

### Why positions are still a major cost

The current event stream carries full `position` objects on every event:

```text
text event
  -> start point { line, column, offset }
  -> end point   { line, column, offset }
```

That is useful for downstream tooling, but it is also expensive. The parser is
not just allocating the final event object. It is also computing and allocating
the nested point objects around it.

The benchmark work in `mod_bench.ts` exists to split that cost into parts so we
can ask a more precise question:

- how much time comes from creating the event object itself?
- how much comes from building fresh nested position objects?
- how much comes from computing line and column data in the first place?

That framing matters because it keeps the next performance decisions grounded.
If the expensive part is mostly position computation and allocation, the right
next step is not random micro-optimization. The right next step is to decide
whether the parser needs eager full positions everywhere, or whether some mode
can compute them lazily.


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

Implemented:

| File | Role |
|------|------|
| `text_source.ts` | `TextSource` interface and string adapter |
| `token.ts` | `Token` interface, `TokenType` const-object |
| `events.ts` | `WikitextEvent` union, constructors |
| `ast.ts` | Wikist node types, type guards, builders |
| `tokenizer.ts` | Generator-based `charCodeAt` scanner |
| `block_parser.ts` | Block-level event emitter |
| `mod.ts` | Re-exports all public APIs |

Planned:

| File | Role |
|------|------|
| `inline_parser.ts` | Inline event enrichment |
| `parse.ts` | Orchestration (tokenize -> block -> inline -> tree) |
| `tree_builder.ts` | `buildTree(events)` to `WikistRoot` |
| `stringify.ts` | AST to wikitext (round-trip) |
| `filter.ts` | Filter/visit for tree and event streams |
| `session.ts` | `createSession()` stateful API |

Advanced modules (planned): `async_tokenizer.ts`, `push_parser.ts`,
`incremental.ts`, `compile_html.ts`, `extensions.ts`, `unified.ts`.
