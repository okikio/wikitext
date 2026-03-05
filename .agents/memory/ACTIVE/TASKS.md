# Tasks

Rules:
- Each task is small enough to complete in one iteration.
- Each task has clear, verifiable acceptance checks.

## Queue

- [x] T01: Rewrite copilot instructions and docs config (Phase 0)
  - Why: Old undent content needs replacing with wikitext parser context
  - Done when:
    - [x] `.github/copilot-instructions.md` rewritten
    - [x] `typescript.instructions.md` updated with wikist types
    - [x] `testing.instructions.md` updated with wikitext edge cases
    - [x] `benchmarking.instructions.md` updated with wikitext competitors
    - [x] `changelog.md` reset
    - [x] `readme.md` stub rewrite
    - [x] `scripts/build_npm.ts` updated
    - [x] `deno.json` publish includes updated

- [x] T02: Update .agents/ files and write docs/
  - Why: Research and architecture not yet documented in repo
  - Done when:
    - [x] `.agents/memory/` files updated for wikitext
    - [x] `.agents/guides/codebase-patterns.md` rewritten
    - [x] `.agents/memory/ACTIVE/` files current
    - [x] `docs/architecture.md` written
    - [x] `docs/wikist-spec.md` written
    - [x] `docs/research.md` written

- [ ] T03: Implement AST spec and event types (Phase 1)
  - Why: Foundation types that all other modules depend on
  - Done when:
    - [ ] `text_source.ts` defines `TextSource` interface
    - [ ] `ast.ts` defines all 26+ node types with type guards and builders
    - [ ] `events.ts` defines range-first `WikitextEvent` union with constructors
    - [ ] `Conflict` type reserved in union (no guards/builders)
    - [ ] `deno doc --lint mod.ts` passes
    - [ ] `deno task test` passes

- [ ] T04: Implement tokenizer (Phase 2)
  - Why: Character-level scanner is the lowest layer
  - Done when:
    - [ ] `token.ts` defines Token interface and TokenType enum
    - [ ] `tokenizer.ts` is a working generator-based scanner over `TextSource`
    - [ ] Token coverage: every input code unit is covered
    - [ ] Never-throw fuzz check passes
    - [ ] `deno task test` passes

## Parking lot

- [ ] P01: Write ADR for events-first architecture decision
- [ ] P02: Write ADR for UTF-16 offset choice
- [ ] P03: Delete old undent files (_repl.ts, mod_bench.ts, mod_memory_test.ts)
- [ ] P04: Write ADR for TextSource abstraction decision
- [ ] P05: Write ADR for range-first events vs string-carrying events
- [ ] P06: Implement keystroke-loop benchmark (Phase 7)
- [ ] P07: Implement append-only stream benchmark (Phase 6)
- [ ] P08: Implement remote merge burst benchmark (Phase 7)
- [ ] P09: Evaluate Anchor API as separate package vs core (Phase 8)
