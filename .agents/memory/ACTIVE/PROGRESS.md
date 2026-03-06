# Progress

## Current status

- Foundation types complete and published (text_source.ts, token.ts, events.ts, ast.ts)
- Educational docs and TSDoc added across all source and test files
- Next task: T04 (Tokenizer implementation)
- Blockers: none

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
- What's implemented:
  - text_source.ts, token.ts, events.ts, ast.ts (all published)
  - mod.ts re-exports all of the above
  - Tests: mod_test.ts, ast_test.ts, mod_memory_test.ts
  - Benchmarks: mod_bench.ts
- What's NOT implemented yet:
  - tokenizer.ts, block_parser.ts, inline_parser.ts
  - parse.ts, tree_builder.ts, stringify.ts, filter.ts
  - session.ts
- Verification commands:
  - `deno task test`
  - `deno task bench`
  - `deno doc --lint mod.ts`
