# Progress

## Current status

- Today's focus: T02.5: Integrate TextSource/Session/stability-frontier into plan and docs
- Next task: T03 (AST spec + event types + TextSource interface)
- Blockers: none

## Completed

- [x] T01: Rewrite copilot instructions and docs config (Phase 0)
  - `.github/copilot-instructions.md` rewritten for wikitext parser
  - `typescript.instructions.md`: added wikist type naming table
  - `testing.instructions.md`: wikitext edge cases, event invariants
  - `benchmarking.instructions.md`: wikitext competitors, benchmark modes
  - `changelog.md` reset, `readme.md` stub rewrite
  - `scripts/build_npm.ts` updated, `deno.json` publish includes updated

- [x] T02: Update .agents/ files and write docs/ (Phase 0 continued)
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
  - `.agents/memory/ACTIVE/` files updated with new phases and risks
  - `.agents/guides/codebase-patterns.md`: added TextSource and range-first
    event patterns
  - `.agents/memory/GLOSSARY.md`: new terms (TextSource, Session, stability
    frontier, PositionMap, Conflict node)
  - `.github/copilot-instructions.md`: updated architecture overview and
    naming conventions
  - `.github/instructions/benchmarking.instructions.md`: added live benchmark
    suites

## Notes for the next agent

- Assumptions made:
  - Flat file layout at root (no src/ folder)
  - "wikist" spec name for the AST
  - Events-first architecture (not AST-first)
  - Range-first events: text/token events carry offset ranges, not strings
  - `TextSource` abstraction: defined in Phase 1, `string` satisfies it
  - Session API: thin stateful wrapper, built on stateless pipeline
  - Stability frontier: documented now, implemented in Phase 6
  - `Conflict` type: reserved in wikist union, not implemented in MVP
  - Anchor API: deferred to Phase 8 or separate package
  - Syntax-first scope: MediaWiki quirks deferred to Phase 8 profile
- Files touched:
  - `.github/copilot-instructions.md`, `.github/instructions/*.md`
  - `.agents/memory/`, `.agents/guides/`
  - `changelog.md`, `readme.md`, `scripts/build_npm.ts`, `deno.json`
  - `docs/architecture.md`, `docs/wikist-spec.md`, `docs/research.md`
- Verification to run:
  - `deno task test` (will fail: mod.ts still has old undent code)
  - `deno doc --lint mod.ts` (will fail until Phase 1 rewrites mod.ts)
- Old undent files still present (mod.ts, _repl.ts, mod_bench.ts,
  mod_memory_test.ts): to be rewritten/deleted in Phase 1+
