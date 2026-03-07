# Progress

## Current status

- Foundation types complete and published (text_source.ts, token.ts, events.ts, ast.ts)
- Tokenizer complete (tokenizer.ts) with 118 tests including property-based fuzz
- Block parser complete (block_parser.ts) with 61 tests including property-based fuzz
- Phase 3 review complete: 3 bugs fixed, heading parser rewritten, unused vars cleaned
- Dedicated test files added for events.ts (42 tests), token.ts (31 tests), text_source.ts (61 tests)
- Educational docs and TSDoc added across all source and test files
- Documentation quality audit complete (header clarity, opening ledes, intent-grounded comments)
- Test imports use deno-lint-ignore comments with inline jsr:/npm: specifiers (no deno.json import map)
- Benchmarks GC-annotated for allocation-heavy tokenizer paths
- State snapshot recording deferred to Phase 7 (TODO comment in block_parser.ts)
- Current task: Phase 4 complete; Phase 5 orchestration not started
- Longer-term direction: broader profile-driven document engine is recorded,
  but current focus remains validating parser primitives through the wikitext
  parser first
- Ecosystem direction: unified compatibility stays desirable, but through
  optional adapters at the edge while the native runtime model remains the
  long-term target
- Blockers: none
- Total tests: 479, 0 failures, 0 compile errors

## Completed

- [x] T01: Rewrite copilot instructions and docs config
  - `.github/copilot-instructions.md` rewritten for wikitext parser
  - `typescript.instructions.md`: added wikist type naming table
  - `testing.instructions.md`: wikitext edge cases, event invariants
  - `benchmarking.instructions.md`: wikitext competitors, benchmark modes
  - `changelog.md` reset, `readme.md` rewritten
  - `scripts/build_npm.ts` updated, `deno.json` publish includes updated

- [x] T02: Update .agents/ files and write docs/
  - `.agents/memory/` core files rewritten (PROJECT, GLOSSARY, CONVENTIONS, INDEX)
  - `.agents/memory/ACTIVE/` files updated (PLAN, TASKS, PROGRESS, RISKS)
  - `.agents/guides/codebase-patterns.md` rewritten
  - Checklists updated for wikitext parser
  - `docs/architecture.md`: full pipeline architecture
  - `docs/wikist-spec.md`: formal AST node specification
  - `docs/research.md`: wikitext syntax research, prior art, design rationale

- [x] T02.5: Integrate streaming/collab/hybrid-editing design into plan
  - `docs/architecture.md`: added TextSource, Session API, stability frontier,
    hybrid editing design note, PositionMap, Edit interface, range-first events
  - `docs/wikist-spec.md`: reserved Conflict node type
  - `docs/research.md`: added streaming, hybrid editing, collaboration research
  - `.agents/memory/GLOSSARY.md`: new terms (TextSource, Session, stability
    frontier, PositionMap, Conflict node)

- [x] T03: Implement AST spec, event types, TextSource, Token
  - `text_source.ts`: TextSource interface + slice() helper
  - `token.ts`: TokenType const-object (40+ types), Token interface, isToken()
  - `events.ts`: Point, Position, 5 event interfaces, constructors, type guards
  - `ast.ts`: 37 node types, WikistNode union, type guards, builder functions
  - `mod.ts`: barrel re-exports all public APIs
  - `mod_test.ts`: smoke tests for exports
  - `mod_bench.ts`: mitata benchmarks for foundational operations
  - `mod_memory_test.ts`: memory regression tests
  - `ast_test.ts`: comprehensive tests (builders, guards, property-based)
  - Educational TSDoc added across all files with ASCII diagrams
  - `readme.md`: complete with full API surface, working examples, status table
  - `deno doc --lint mod.ts` passes
  - `deno task test` passes

- [x] T04: Implement tokenizer
  - `tokenizer.ts`: generator-based charCodeAt scanner over TextSource
  - Yields offset-based tokens (never stores string values)
  - Recognizes all 40+ TokenType values: headings, lists, tables, links,
    templates, arguments, bold/italic, HTML tags, comments, entities,
    signatures, behavior switches, thematic breaks, preformatted markers
  - Never-throw invariant: verified with fast-check property-based tests
  - Token coverage invariant: ranges tile input with no gaps or overlaps
  - Determinism: same input always produces same token sequence
  - `tokenizer_test.ts`: 112 tests (example-based + boundary + property-based)
  - `mod.ts`: re-exports tokenize()
  - `mod_bench.ts`: tokenizer throughput benchmarks on 6 representative inputs
  - `deno task test` passes (227 total tests)

- [x] T04.5: Phase 2 review and quality gate
  - Documentation quality audit: fixed weak headers, buried ledes, added
    intent-grounding opening lines to all tokenizer inline comments
  - Test fixes: added 6 edge case tests (tab, self-closing tags, entities,
    CRLF, less-than digit, bare ampersand), fixed unused variable
  - Centralized test imports via deno.json import map (removed inline jsr:/npm: specifiers)
  - Benchmark fixes: drainTokenize now returns token count for do_not_optimize,
    added .gc('inner') to all tokenizer benchmarks
  - Updated .agents/ files: PROJECT.md (tokenizer now listed as implemented),
    PROGRESS.md, TASKS.md
  - `deno task test` passes (253 total tests)

- [x] T05: Implement block parser (Phase 3)
  - `block_parser.ts`: ~530-line block-level event generator
  - Handles headings, paragraphs, bullet/ordered/definition lists, tables,
    thematic breaks, preformatted blocks
  - Event well-formedness: every enter has a matching exit (stack discipline)
  - Never-throw: verified with fast-check property-based tests
  - `block_parser_test.ts`: 61 tests (example-based + property-based)
  - `mod.ts`: re-exports `blockEvents()`
  - `deno task test` passes (314 total tests at time of completion)

- [x] T05.5: Phase 3 review, bug fixes, and dedicated test files
  - Heading parser rewritten from inline-check to collect-then-trim strategy:
    the tokenizer emits EQUALS (not HEADING_MARKER_CLOSE) for mid-line `==`,
    so the old approach missed trailing close markers
  - Fallback positions fixed in closeLevels, closeCell, closeRow: were using
    `pointAt(buf.tracker, 0)` which gave offset 0 at end of input; now use
    tracker's current state
  - List type-switching fixed: `* A\n# B` now closes the bullet list before
    opening an ordered list at the same depth
  - Unused variables cleaned up (firstStart, lastEnd, lineStartPt, etc.)
  - State snapshot recording deferred to Phase 7 with TODO comment
  - Test imports switched from deno.json import map to deno-lint-ignore
    comments with inline jsr:/npm: specifiers
  - Created `events_test.ts` (42 tests): constructors, type guards,
    ErrorEventOptions merging, property-based round-trips
  - Created `token_test.ts` (31 tests): 39 token types verified by category,
    value uniqueness, isToken() with 15+ edge cases, property-based
  - Created `text_source_test.ts` (61 tests): string conformance, Unicode
    (CJK, RTL, astral/emoji surrogates), line endings, slice() helper,
    custom TextSource impl, property-based round-trips
  - `deno task test` passes (448 total tests)

- [x] T06: Implement inline parser (Phase 4)
  - `inline_parser.ts`: offset-driven inline enrichment generator
  - Covers apostrophe emphasis, wikilinks, image/category namespace dispatch,
    bracketed and bare external links, templates, parser functions,
    triple-brace arguments, comments, behavior switches, signatures,
    HTML entities, `<br>`, `<nowiki>`, `<ref>`, and generic HTML tags
  - Adjacent block-parser text spans are merged before enrichment so inline
    constructs can span token-sized text events
  - Position recovery uses line-start tables instead of per-character `Point`
    allocation in the hot path
  - `inline_parser_test.ts`: focused examples, behavior-switch edge cases, and
    property-based invariants
  - `mod.ts`: re-exports `inlineEvents()`
  - `mod_bench.ts`: now benchmarks token-only, block-events, and full inline
    enrichment paths on representative inputs
  - `deno task test` passes (479 total tests)

## Notes for the next agent

- Conventions:
  - Flat file layout at root (no src/ folder)
  - "wikist" spec name for the AST (following mdast/hast/xast)
  - Events-first architecture (not AST-first)
  - Range-first events: text/token events carry offset ranges, not strings
  - TokenType uses const-object + literal union (not enum)
  - AST node types use kebab-case discriminants
  - Event fields use snake_case (node_type, start_offset, etc.)
  - `TextSource` abstraction: plain `string` satisfies it
  - Phases are internal planning only: docs say "not yet implemented"
  - Test imports use `// deno-lint-ignore-file no-import-prefix no-unversioned-import`
    with inline `jsr:@std/testing/bdd`, `jsr:@std/expect`, `npm:fast-check` specifiers
    (there is no deno.json import map)
- What's implemented:
  - text_source.ts, token.ts, events.ts, ast.ts (all published)
  - tokenizer.ts: generator-based scanner over TextSource
  - block_parser.ts: block-level event generator (headings, paragraphs, lists,
    definition lists, tables, thematic breaks, preformatted blocks)
  - mod.ts re-exports all of the above
  - Tests: mod_test.ts, ast_test.ts, mod_memory_test.ts, tokenizer_test.ts,
    block_parser_test.ts, events_test.ts, token_test.ts, text_source_test.ts
    (448 total tests, 0 failures)
  - Benchmarks: mod_bench.ts (foundations + tokenizer throughput, GC-annotated)
- Token count: TokenType has 39 entries (not 45 as some older docs say)
- Block parser notes:
  - Heading parser uses collect-then-trim: tokenizer emits EQUALS for mid-line
    `==`, not HEADING_MARKER_CLOSE, so trailing close markers must be trimmed
    from collected line tokens
  - State snapshot recording is deferred to Phase 7 (TODO comment in place)
  - blockEvents() accepts (source: TextSource, tokens: Iterable<Token>)
- What's NOT implemented yet:
  - parse.ts, tree_builder.ts, stringify.ts, filter.ts
  - session.ts
- Verification commands:
  - `deno task test`
  - `deno task bench`
  - `deno doc --lint mod.ts`
