# Research

This document captures the research that informed the design of
`@okikio/wikitext`: wikitext syntax characteristics, prior art analysis,
ecosystem survey, and the rationale behind key architectural decisions.


## Wikitext syntax overview

Wikitext is the markup language used by MediaWiki (Wikipedia and thousands of
other wikis). Unlike Markdown, it has no formal grammar. MediaWiki's PHP parser
is the de facto spec: behavior is defined by what the parser does, not by a
written standard.

### Key characteristics

- **Line-oriented block structure.** Block elements are determined by the first
  character(s) of a line: `=` for headings, `*` for bullet lists, `#` for
  ordered lists, `:` for indentation / definition descriptions, `;` for
  definition terms, `{|` for tables, `----` for horizontal rules, leading space
  for preformatted text.

- **Inline markup uses paired delimiters.** `''italic''`, `'''bold'''`,
  `[[wikilink]]`, `{{template}}`, `[url text]`. These can nest arbitrarily.

- **Templates and transclusion.** `{{TemplateName|arg1|key=value}}` is
  MediaWiki's macro system. Templates are the dominant complexity driver:
  they can span lines, nest deeply, and interact with other markup.

- **No "invalid" input.** Everything renders. Unclosed bold markers close at
  end of line. Unclosed `[[` or `{{` are treated as literal text. Malformed
  tables degrade to best-effort structure. This is both a feature and a parsing
  challenge.

- **Extension tags.** `<ref>`, `<nowiki>`, `<gallery>`, `<syntaxhighlight>`,
  `<math>`, and others. These are HTML-like tags with special MediaWiki
  behavior. Content inside `<nowiki>` is protected from parsing.

- **Behavior switches.** `__TOC__`, `__NOTOC__`, `__FORCETOC__`,
  `__NOEDITSECTION__` — double-underscore tokens that control rendering
  behavior rather than producing visible content.

- **Signatures.** `~~~` (username), `~~~~` (username + timestamp), `~~~~~`
  (timestamp only) — substituted by MediaWiki on save.

### Apostrophe run disambiguation

The most complex inline parsing challenge. MediaWiki uses a heuristic based on
apostrophe run length:

| Run length | Interpretation |
|-----------|----------------|
| 2 | Italic toggle |
| 3 | Bold toggle |
| 4 | One literal apostrophe + bold toggle |
| 5 | Bold + italic toggle |
| >5 | Extra apostrophes are literal, then bold+italic |

Unclosed runs at end of line are implicitly closed. The algorithm is
**line-scoped**: italic and bold markup works correctly only within a single
line. MediaWiki's `doQuotes` method implements a second pass that resolves
ambiguity when a line has mismatched opens/closes. This is under-documented
and requires empirical testing against MediaWiki output.

### Namespace-sensitive links

The link target in `[[Target]]` changes the node type based on namespace prefix:
- `[[File:...]]` or `[[Image:...]]` → image embed (not a text link)
- `[[Category:...]]` → category assignment (not rendered inline)
- `[[Special:...]]` → special page link
- Everything else → internal wikilink

**Leading-colon escape hatch**: a leading colon flips the semantics:
- `[[:Category:Foo]]` → visible link (not a category assignment)
- `[[:File:Foo.png]]` → visible link (not an image embed)

This matters for any parser used in extraction or tooling workflows. The
namespace dispatch must check for and strip the leading colon before deciding
node type.

### Table syntax

Tables have their own mini-language:

```
{| class="wikitable"    (table open + attributes)
|+ Caption              (table caption)
|-                       (row separator)
! Header 1 !! Header 2  (header cells)
|-
| Cell 1 || Cell 2      (data cells)
|}                       (table close)
```

Cells can contain arbitrary wikitext including nested tables, templates, and
links. Tables can appear inside list items. This creates complex nesting
interactions.


## Prior art

### Parsoid (MediaWiki team)

Parsoid is the official MediaWiki wikitext-to-HTML converter. Written in
JavaScript (originally Node.js, now integrated into PHP MediaWiki core via a
ported version). It aims for perfect round-trip fidelity with MediaWiki's PHP
parser.

**Strengths**: most correct wikitext parser in existence, handles every edge
case, backed by the MediaWiki team, PEG grammar (for tokenization) plus
multi-pass transforms.

**Weaknesses for our purposes**: extremely complex (~100K+ lines), tightly
coupled to MediaWiki's template expansion and rendering pipeline, not designed
for standalone use as a source parser. Parsoid is packaged (PHP via Composer,
and a JS API repository exists), so "not published" is inaccurate in the
strict sense. But it is operationally expensive and coupled to MediaWiki-like
configuration and behaviors, making it impractical as a lightweight dependency
for our goals.

**Takeaway**: Parsoid is the correctness reference, not an architecture model.
Use its test cases as a conformance source.

### mwparserfromhell (Python)

The most popular standalone wikitext parser. Used heavily for bot frameworks
and data extraction (including Wikipedia data pipelines).

**Strengths**: good template and link extraction, mature API
(`filter_templates()`, `filter_wikilinks()`), battle-tested on real Wikipedia
content.

**Structural gaps we address**:
- **Lists**: mwparserfromhell parses `# item` as flat Tag+Text. No list nesting
  structure.
- **Tables**: parsed, but represented as `Tag`-like nodes rather than a
  first-class table model (rows/cells/caption). Table extraction and
  structural rewriting are awkward compared to a purpose-built AST.
- **Bold/Italic**: parsed into "style tags" by default (can be disabled with
  `skip_style_tags`), but not modeled as a semantic emphasis layer suitable
  for unist-style transforms or faithful ambiguity handling.
- **Image/Category**: `[[File:...]]` and `[[Category:...]]` are generic
  Wikilink. No namespace dispatch.
- **Redirect**: no distinct node type.
- **Behavior switches**: `__TOC__` etc. not modeled.
- **Parser functions**: `{{#if:...}}` treated as a template. No distinction
  between parser functions (`#if`), variable-style magic words (`PAGENAME`),
  and plain templates.
- **Streaming**: batch-only. No event stream, no incremental parsing.

**Takeaway**: mwparserfromhell defines the baseline for template/link
extraction. We aim for parity there plus substantial structural improvements.
Its `filter_*()` API is a good ergonomic model.

### micromark (Markdown)

micromark is a CommonMark parser for JavaScript. It pioneered the
event-stream-first architecture in the JS parsing ecosystem: tokens are emitted
as events, and the AST (mdast) is built by a separate consumer.

**Architecture influence**: This project directly adopts micromark's key
insight: events as the fundamental interchange format, with AST as a consumer.
The three streaming modes (outline, full, progressive) extend this pattern.

**Specific patterns borrowed**:
- Event well-formedness as a contract (enter/exit stack discipline)
- Lazy tree building (build tree from events, not during parsing)
- Content type separation (flow/string/text → our block/inline split)

### pulldown-cmark (Rust, Markdown)

A pull-parser for CommonMark in Rust. Emits events via an iterator
(start tag, end tag, text, etc.) without building a tree.

**Architecture influence**: Reinforced the events-first pattern. Demonstrated
that pull iteration (generator/iterator) is more composable than push
(callbacks) as the primary API, with push as a thin adapter.

### lol-html (Cloudflare, Rust)

Low Output Latency streaming rewriter for HTML. Uses a SAX-style event model
with content handlers. Designed for rewriting HTML on the fly at CDN edge.

**Architecture influence**: Demonstrated that streaming event parsing can
achieve very low latency, even for complex markup. Reinforced the value of
push-style API as a secondary interface for streaming use cases.

### wtf_wikipedia (JavaScript)

JavaScript library for parsing Wikipedia articles into structured JSON.
Batch-only, proprietary AST format.

**Strengths**: handles many wikitext constructs, reasonable extraction API,
active maintenance.

**Weaknesses**: non-standard AST (not unist-compatible), no streaming, no
incremental parsing, no event model.

**Takeaway**: primary JS benchmark competitor. We aim for better throughput
while producing a standards-compliant AST.

### wikiparser-node (JavaScript/TypeScript)

Another JS wikitext parser with broader syntax coverage than wtf_wikipedia.
TypeScript-native, produces an AST, and supports browser environments.
Prominent enough in the ecosystem that MediaWiki's own "Alternative parsers"
list includes it.

**Strengths**: wide syntax coverage, TypeScript types, AST output, browser
support, active maintenance.

**Weaknesses for our purposes**: not unist-compatible, no streaming or
incremental parsing, different architectural goals.

**Takeaway**: primary competitor alongside wtf_wikipedia for JS benchmarks.
Deserves side-by-side benchmarking, not just footnote mention.


## Ecosystem integration

### unist (Universal Syntax Tree)

The [unist][] specification provides a universal format for syntax trees.
Ecosystem libraries like `unist-util-visit`, `unist-util-filter`, and
`unist-util-map` work on any unist-compatible tree.

Wikist follows unist: every node has `type`, optional `position`, optional
`data`. Parent nodes have `children`. Literal nodes have `value`. This
unlocks the entire unist utility ecosystem without additional adapters.

[unist]: https://github.com/syntax-tree/unist

### unified

The [unified][] framework orchestrates parsing and serialization via plugins.
A unified plugin pair consists of:
- A parser plugin: input string → AST
- A compiler plugin: AST → output string

Phase 8 adds `wikitextParse()` (parser) and `wikitextStringify()` (compiler)
as unified plugins, plus bridge plugins (`wikistToHast`, `wikistToMdast`)
for cross-format conversion.

[unified]: https://unifiedjs.com

### LSP compatibility

Position semantics use UTF-16 code unit offsets, matching the Language Server
Protocol's default encoding. This makes wikist positions directly usable in
editor tooling without conversion.


## Key design decisions and rationale

### Why events-first (not AST-first)

Most parsers build an AST directly and discard intermediate state. This forces
every consumer to pay the full cost of tree allocation, even when they only
need a subset of the information (e.g., extracting template names, building a
table of contents).

Events are cheaper to produce and more flexible to consume:
- **No allocation**: events can drive HTML output directly without building a
  tree.
- **Filtering**: consumers can skip entire subtrees by ignoring enter/exit
  pairs between boundaries they don't care about.
- **Streaming**: events flow naturally through async pipelines.
- **Multiple outputs**: the same event stream can feed a tree builder, an HTML
  compiler, and a filter simultaneously.

The AST is still available. `buildTree(events(input))` produces a full wikist
tree. The architecture merely decouples event production from tree construction.

### Why UTF-16 offsets (not bytes, not code points)

JavaScript strings are sequences of UTF-16 code units. `string.charCodeAt(i)`
returns the code unit at index `i`. `string.slice(a, b)` works on code unit
indices.

Using UTF-16 offsets means:
- `input.slice(pos.start.offset, pos.end.offset)` returns the source text.
- No conversion needed for `charCodeAt` scanning.
- Matches LSP default position semantics (UTF-16 code units). Since LSP 3.17,
  clients and servers can negotiate other encodings (UTF-8, UTF-32), but
  UTF-16 support remains mandatory for backwards compatibility. Wikist stores
  UTF-16 offsets; adapters may translate if a client negotiates another
  encoding.
- Avoids subtle bugs with surrogate pairs (emoji, CJK supplementary, etc.).

UTF-8 byte offsets are available opt-in via `node.data?.utf8Offset` for
consumers that need them (e.g., interfacing with native tooling).

### Why offset-based tokens (not value strings)

Tokens carry `start` and `end` offsets into the input string. They do not carry
a `value` field. A `slice(input, token)` helper resolves the string on demand.

Benefits:
- **No per-token string allocation.** The tokenizer runs without creating any
  new strings.
- **Avoids sliced-string retention risk.** V8's `string.slice()` can create a
  "sliced string" that retains a reference to the parent string. In practice,
  this behavior is heuristic-driven (not unconditional), but a small token
  value can pin a megabyte-long input string in memory when it triggers.
  Offset-based tokens sidestep this risk: consumers resolve strings only when
  needed, at the scope where the input string lifetime is managed.
- **Cheaper iteration.** Token objects are small (type + two numbers).

### Why "wikist" as the spec name

Following the naming pattern established in the unified ecosystem:
- mdast = Markdown Abstract Syntax Tree
- hast = HTML Abstract Syntax Tree
- xast = XML Abstract Syntax Tree
- **wikist = Wiki Syntax Tree**

The name signals unist compatibility and positions the spec as a peer in the
ecosystem.

### Why syntax-first scope (not MediaWiki-compatible)

MediaWiki's parser has accumulated behavioral quirks over 20+ years. Matching
every quirk would delay the MVP indefinitely and couple the parser to a
specific MediaWiki version.

The `syntax` profile (MVP default) uses deterministic rules derived from the
documented wikitext syntax. It produces correct, well-structured trees for all
standard wikitext constructs. The `mediawiki` profile (Phase 8) adds
quirk-matching for consumers that need exact rendering parity.

This separation keeps the core clean and testable while providing a path to
full compatibility.

### Why flat file layout

All source modules live at the repository root alongside `mod.ts`. No `src/`
folder.

Rationale:
- Flat layout reduces import path depth and navigation friction in small-to-
  medium projects.
- `mod.ts` re-exports all public APIs, so consumers use `@okikio/wikitext`
  without knowing the internal layout.
- Matches the convention used by many Deno-first packages.

### Why construction-time specialization for extensions

Extensions could run as runtime hooks checked on every event (simple but slow)
or as compile-time code generation (fast but complex). Construction-time
specialization is the middle ground: feature gates are resolved once when
creating a parser instance. The resulting instance has baked-in dispatch tables
with no per-character flag checks.

This keeps the inner scanning loop tight while allowing full extensibility at
the API level.


## Performance targets

- **Throughput**: best-in-class among JS wikitext parsers on real Wikipedia
  articles. Benchmark against wtf_wikipedia and wikiparser-node.
- **Latency**: predictable per-character cost. No pathological cases that
  cause quadratic blowup.
- **Memory**: offset-based tokens and lazy tree building minimize allocation.
  A `tokens(input)` consumer allocates no strings beyond the input itself.
- **Scalability**: architecture supports a WASM backend replacing a hot path
  without changing the public API.


## Template, parser function, and magic word classification

MediaWiki distinguishes several kinds of `{{ }}` constructs that share the same
delimiter syntax but differ in behavior:

| Construct | Example | Prefix | Behavior |
|-----------|---------|--------|----------|
| Template | `{{Infobox\|...}}` | none | Transcludes another page |
| Parser function | `{{#if:...\|...\|...}}` | `#` | Built-in logic; name starts with `#` |
| Variable-style magic word | `{{PAGENAME}}` | none | Substituted by MediaWiki, configured set |
| Behavior switch | `__TOC__` | `__` | Double-underscore, not `{{ }}` syntax |

Parser functions always start with `#` (`#if`, `#switch`, `#invoke`, `#expr`).
Variable-style magic words (`PAGENAME`, `FULLPAGENAME`, `CURRENTYEAR`) have no
`#` prefix and are a configured set that MediaWiki recognizes before template
lookup. Behavior switches use `__WORD__` syntax and are not `{{ }}` constructs
at all.

A source parser cannot resolve the difference between a variable-style magic
word and a template without knowing MediaWiki's configured word list. The
default strategy: parse all `{{ }}` as Template nodes, let profiles or
consumers reclassify known magic words and parser functions based on name
matching.


## Pre-save transform (PST)

Signatures (`~~~`, `~~~~`, `~~~~~`) are expanded at **save time**, not render
time. MediaWiki's pre-save transform also handles `{{subst:...}}` expansion
and `{{int:...}}` internalization.

The source parser sees these as literal tilde runs and `{{subst:Template}}`
respectively. A future `mediawiki` profile phase could model PST as a
transform pass, but the MVP parser treats them as:
- `SignatureMarker` node for tilde runs (3–5 tildes at line start or inline)
- `Template` node for `{{subst:...}}` with a `subst` flag in `data`

PST is relevant for tools that operate on saved wikitext versus live-preview
wikitext. The parser should document which layer it models.


## Transclusion control tags

Three special tags control what content is visible when a page is transcluded
versus viewed directly:

| Tag | When transcluded | When viewed directly |
|-----|-------------------|----------------------|
| `<noinclude>...</noinclude>` | Content hidden | Content visible |
| `<includeonly>...</includeonly>` | Content visible | Content hidden |
| `<onlyinclude>...</onlyinclude>` | Only this content shown | Content visible |

These are distinct from extension tags — they control transclusion scoping,
not rendering. The parser must model them as structural nodes (not just generic
HTML tags) because they affect what content is "active" depending on context.

In a source parser, all three are always visible in the AST. A consumer or
profile can use the node type to filter content based on transclusion context.


## Open questions

These decisions are deferred to later phases when more implementation
experience is available:

1. **Exact apostrophe algorithm**: the MediaWiki heuristic has undocumented edge
   cases. Defer exact matching to Phase 8 `mediawiki` profile.
2. **Cross-block template span limits**: how deep should incremental reparsing
   search for a neutral boundary when templates span many blocks?
3. **Extension tag discovery**: how does the parser learn about new extension
   tags besides a hardcoded list? Phase 8 `registerTagHandler` addresses this.
4. **Source map granularity**: should source maps track individual characters
   or token-level ranges? Token-level ranges are sufficient for most use cases.
5. **Anchor abstraction scope**: should the parser own a full anchor lifecycle
   (createAnchor/resolveAnchor with bias) or leave that to editor/collab
   packages? Current decision: provide `PositionMap` from `applyChanges()`
   (covers 80% of cursor/selection mapping), defer full anchor API to a
   separate package.


## Streaming and live editing research

This section captures research on streaming, collaboration, and hybrid editing
that informed the `TextSource`, `Session`, and stability frontier designs.

### The "hybrid editing overlay" pattern

Modern editors that feel smooth for structured markup do not commit fully to
either text-first (plain textarea) or block-first (Notion-style) editing.
Instead they:

- Keep an underlying text buffer (so typing, selection, copy/paste, undo all
  feel natural).
- Maintain an incremental parse tree (so they understand structure cheaply).
- Render layout effects as decorations or widgets, not as a separate block
  database.
- Temporarily expand markup near the cursor so edits remain precise, while
  hiding markup elsewhere.

This pattern appears in Typora, Obsidian Live Preview, and CodeMirror
rich-editing plugins. The common failure mode is cursor jumps and line shifting
when the system hides or reveals syntax. The fix is to be surgical: only do the
rich transformation where it is safe and stable, and be conservative elsewhere.

The parser supports this pattern by providing cheap outline events as a
structural overlay, lazy inline parsing outside the viewport, incremental
reparsing with bounded dirty ranges, and `PositionMap` for cursor stability.

**References**:
- CodeMirror decorations and widget decorations for layout overlays.
- CodeMirror state fields and incremental plumbing.
- Hybrid rich editing over a text buffer (codemirror-rich-markdoc).
- Typora's "expand markup near cursor" behavior.
- Obsidian Live Preview discussions on cursor/line shifting.

### Stability frontier for streaming

Streaming markdown UIs (LLM output, progressive loading) stay smooth by
treating the document as a stable prefix plus a provisional tail. The stable
prefix can be rendered with full structure. The provisional tail is kept as
plain text or minimally parsed until delimiters close.

Wikitext needs this more than Markdown because `[[`, `{{`, `{|`, and `<ref>`
can stay open across many lines. Without a stability frontier, each new chunk
could invalidate the entire parse.

The stability frontier offset is maintained by the session/tokenizer. Stable
events are guaranteed not to be invalidated. Provisional tail events may be
replaced later.

**References**:
- Chrome's best practices for rendering streamed LLM responses.
- Lezer's incremental parsing and fragment reuse model.

### Collaboration readiness

The parser stays collaboration-algorithm-agnostic. The integration boundary is
`applyChanges(edits)` with `Edit = { offset, deleteCount, insertText }`. This
works with OT, CRDT, Eg-walker, or any other concurrency model.

Key design choices:
- `TextSource` abstraction decouples the parser from text storage. A CRDT text
  type (Yjs `Y.Text`, Automerge) can implement `TextSource` directly.
- `PositionMap` output from `applyChanges()` maps old offsets to new offsets,
  preserving cursor/selection/comment anchors across edits.
- Edit coalescing: collaboration engines emit many tiny operations. The session
  coalesces close edits into one reparse window when safe.
- The `Conflict` node type is reserved in the wikist spec (not implemented in
  MVP) as a future-proofing slot for collaboration conflict representation,
  inspired by jujutsu's "conflict as value" model.

**References**:
- Yjs relative positions (anchor semantics).
- Jujutsu conflicts-as-first-class-values model.
