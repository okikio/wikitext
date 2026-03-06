# Glossary

## Project-specific

- **wikist**: Wiki Syntax Tree. The AST spec for this parser, extending unist.
  Named after the mdast/hast/xast pattern.
- **WikistRoot**: Root node of a parsed wikist tree. Analogous to mdast's
  `Root`.
- **WikitextEvent**: Discriminated union of enter/exit/text/token events.
  The fundamental interchange format of the parser.
- **Token**: Lowest-level unit from the tokenizer. Carries start/end offsets
  into the input string (not value strings) and a `TokenType` discriminant.
  Defined in `token.ts`.
- **Event well-formedness**: Every `enter(X)` has a matching `exit(X)` with
  proper nesting (stack discipline). A parser contract.
- **Never-throw guarantee**: The parser produces a valid tree for any input.
  Malformed wikitext triggers error recovery, not exceptions.
- **Outline events**: Block-only event stream (`outlineEvents()`). Skips
  inline parsing for cheap structural extraction.
- **State snapshot**: Compact parser state recorded at block boundaries.
  Enables incremental reparsing by finding "neutral" restart points.
- **TextSource**: Minimal interface (`length`, `slice`, `charCodeAt`,
  optional `iterSlices`) that abstracts the backing text. Plain `string`
  satisfies it; rope trees, CRDTs, and append buffers can implement it too.
- **Range-first events**: Event design where `text`/`token` events carry
  `start_offset`/`end_offset` instead of a `value` string. Text is resolved
  lazily via `slice(source, evt)`. Avoids per-event string allocation.
- **Session**: Stateful wrapper (`createSession(source)`) around the
  stateless pipeline. Caches parse state, exposes streaming and incremental
  APIs. Grows surface area across Phases 5–7.
- **Stability frontier**: UTF-16 offset up to which emitted events are
  guaranteed stable (won't change as more input arrives). Events before the
  frontier are "stable"; events after are "provisional".
- **PositionMap**: Old-offset → new-offset mapping returned by
  `session.applyChanges()`. Lets callers (editors, annotations) translate
  positions across edits. Covers ~80% of anchor use cases.
- **Edit**: `{ offset, deleteCount, insertText }`, a single text mutation
  expressed as a splice. Collab-algorithm-agnostic; Yjs, Automerge, or
  manual edits all reduce to this shape.
- **Edit coalescing**: Merging adjacent or overlapping edits into one reparse
  window. Reduces wasted work when multiple small edits arrive in a batch.
- **Conflict**: Reserved wikist node type (`type: "conflict"`,
  `variants: WikistNode[][]`). Represents structurally divergent
  interpretations of the same source range (jj-inspired). Not produced by
  the core parser; intended for collab/merge tooling.

## Wikitext constructs

- **Wikilink**: `[[Target|Display text]]`. Internal link to another wiki page.
- **Template**: `{{Name|arg1|key=value}}`. Transclusion marker (source parser
  does not expand).
- **Parser function**: `{{#if:...|...|...}}`, `{{#switch:...}}`,
  `{{#invoke:...}}`. Name starts with `#`. Built-in logic construct.
- **Magic word**: `{{PAGENAME}}`, `{{CURRENTYEAR}}`. Variable-style built-in
  with no `#` prefix. A configured set in MediaWiki. Source parser defaults
  these to Template; profiles or consumers reclassify by name matching.
- **Behavior switch**: `__TOC__`, `__NOTOC__`, `__NOEDITSECTION__`.
  Double-underscore toggle. Not `{{ }}` syntax.
- **Apostrophe run**: Consecutive `'` characters for bold/italic markup.
  2=italic, 3=bold, 5=bold+italic. Resolved by `doQuotes` algorithm.
- **doQuotes**: MediaWiki's line-scoped second-pass algorithm that resolves
  ambiguous apostrophe runs within a single line. Under-documented;
  requires empirical testing against MediaWiki output.
- **Nowiki**: `<nowiki>...</nowiki>`. Suppresses wikitext parsing inside.
- **Leading-colon escape**: `[[:Category:Foo]]` or `[[:File:Foo.png]]`.
  A leading colon in a link target overrides namespace dispatch, producing
  a visible link instead of a category assignment or image embed.
- **Neutral boundary**: A position in the token stream where all tracked
  parser state is at its default value (template depth 0, link depth 0,
  not in table, no open HTML tags, not in nowiki, quote state clean).
  Parsing can resume from scratch at a neutral boundary.
- **PST (pre-save transform)**: MediaWiki expands signatures (`~~~~`) and
  `{{subst:...}}` at save time, not render time. The source parser sees
  these as literal tilde runs and Template nodes respectively.
- **Transclusion control tags**: `<noinclude>`, `<includeonly>`,
  `<onlyinclude>`. Control which content is visible when a page is
  transcluded versus viewed directly. Distinct from extension tags.

## General

- **unist**: Universal Syntax Tree. The base spec for AST node types used by
  the unified ecosystem (mdast, hast, xast).
- **TSDoc**: TypeScript documentation comment format (`/** ... */`) used by
  `deno doc`.
- **JSR**: Jsr.io, the TypeScript-native package registry for Deno.
- **ADR**: Architecture Decision Record. A short document capturing a
  significant design choice, its context, and the rationale.
- **LICM**: Loop Invariant Code Motion. A JIT optimization that hoists
  loop-invariant computations out of the loop. Relevant to benchmark validity.
