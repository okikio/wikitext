# Plan: Wikitext Parser, Event-Driven AST Library

## Outcome

Build `@okikio/wikitext`, an event-stream-first wikitext source parser.
Syntax-first deterministic parse for all documented wikitext constructs, with
strong recovery (never throw). Events are the fundamental interchange format;
AST ("wikist") is a consumer.

## Motivation

No existing JavaScript wikitext parser offers: streaming event output,
incremental reparsing, unist-compatible AST, and high performance in one
package. mwparserfromhell (Python) has good template/link extraction but
lacks first-class table structure (rows/cells/caption), semantic emphasis
layer, and namespace dispatch. wtf_wikipedia is JS but batch-only with a
proprietary AST. wikiparser-node (TypeScript) offers broader syntax coverage
but no streaming or unist compatibility.

## Constraints

- Deno v2 + TypeScript strict + ESM
- `deno doc --lint` compliance
- Never-throw invariant from Phase 2 onward
- UTF-16 code unit offsets (matching JS string indexing)
- charCodeAt scanning, offset-based tokens

## Non-goals

- Template expansion or transclusion
- HTML rendering (direct compilation is a convenience, not a goal)
- MediaWiki behavioral quirk-matching (deferred to "mediawiki" profile)

## Scope discipline

- Use wikitext as the proving ground for parser primitives before expanding
  into a broader profile-driven document engine.
- Treat the parser as one simple workflow step in the larger future system:
  its job is to produce correct primitives that downstream transforms,
  renderers, editors, and session-based tools can consume.
- The longer-term direction includes other markup and rich-text profiles,
  structured CMS blocks, local-first collaboration, offline or local sync,
  and LLM-oriented workflows.
- Unified ecosystem support remains desirable during that transition, but as
  optional adapters over unist-compatible exports rather than as the core
  runtime architecture.
- Do not let that broader direction dilute current work on the wikitext parser
  itself.

## Approach

See `docs/architecture.md` for the full pipeline design. In summary:

1. **Tokenizer**: charCodeAt generator yielding offset-based tokens
2. **Block parser**: consumes tokens, emits block-level enter/exit events
3. **Inline parser**: enriches block events with inline markup events
4. **Consumers**: buildTree, compileHtml, filterEvents, direct callbacks

## Phases

- **Phase 0**: Rewrite copilot instructions, docs, build config ✅
- **Phase 1**: AST spec (`ast.ts`) + event types (`events.ts`) + `TextSource`
  interface + Token types + range-first event payloads ✅
- **Phase 2**: Tokenizer (`tokenizer.ts`) over `TextSource` ✅
- **Phase 3**: Block parser (`block_parser.ts`) + review ✅
- **Phase 4**: Inline parser (`inline_parser.ts`) ← **next**
- **Phase 5**: Public API, tree builder, stringify, filter + corpus tests.
  Session-based API lands (`createSession()` with `.events()`, `.outline()`,
  `.parse()`).
- **Phase 6**: Async streaming, push API, progressive blocks. Stability
  frontier and stable/provisional drain support. `session.write(chunk)` +
  `session.drainStableEvents()`.
- **Phase 7**: Incremental reparsing, direct HTML compilation.
  `session.applyChanges(edits)` with batch coalescing, `PositionMap` return.
- **Phase 8**: Extensions, unified plugins, profiles, scaled hardening.
  Optional `Conflict` node type. Anchor API if needed (or separate package).
  Collab engine adapters.

## Key decisions

See `docs/architecture.md` for rationale. Summary:
- Events-first (not AST-first)
- Range-first events (offset ranges, not string values)
- `TextSource` abstraction (string/rope/CRDT-agnostic)
- Session API for live use cases (built on stateless pipeline)
- Stability frontier for streaming (stable prefix vs. provisional tail)
- Three named streaming modes
- UTF-16 offsets (not bytes, not code points)
- Offset-based tokens (no value strings)
- Flat file layout (no src/)
- "wikist" spec name (following mdast/hast/xast pattern)
- Profiles as Phase 8 sugar over feature gates
- `Conflict` node type reserved (not implemented in MVP)
- Hybrid editing overlay as a design constraint (not building an editor)
- Leading-colon namespace escape (`[[:Category:Foo]]` → Wikilink)
- ParserFunction classification by `#` prefix; magic words parse as Template
  by default (profiles reclassify)
- Leaf coverage invariant relaxed: delimiter chars covered by parent position
  ranges, not guaranteed to have dedicated leaf nodes
- Cross-mode consistency: outlineEvents/events/parse must agree on block
  structure
- Streaming replacement: Model A (two channels + tail reset) preferred;
  Model B (patch stream) as fallback if needed at Phase 6
- String fields (target, name) are convenience lossy fields; authoritative
  source text recoverable from position offsets
