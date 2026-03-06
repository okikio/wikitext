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

- [x] T03: Implement AST spec, event types, TextSource, Token
  - Why: Foundation types that all other modules depend on
  - Done when:
    - [x] `text_source.ts` defines `TextSource` interface + `slice()` helper
    - [x] `token.ts` defines `TokenType` const-object (40+ types), `Token`, `isToken()`
    - [x] `events.ts` defines range-first `WikitextEvent` union with constructors + guards
    - [x] `ast.ts` defines 37 node types with type guards and builder functions
    - [x] `Conflict` type reserved in union (no guards/builders)
    - [x] `deno doc --lint mod.ts` passes
    - [x] `deno task test` passes
    - [x] Educational TSDoc with ASCII diagrams across all files

- [x] T04: Implement tokenizer
  - Why: Character-level scanner is the lowest layer
  - Done when:
    - [x] `tokenizer.ts` is a working generator-based scanner over `TextSource`
    - [x] Token coverage: every input code unit is covered
    - [x] Never-throw fuzz check passes
    - [x] `deno task test` passes

- [x] T04.5: Phase 2 review and quality gate
  - Why: Ensure Phase 2 output is solid before moving to block parser
  - Done when:
    - [x] Doc quality audit: headers, ledes, intent comments all reviewed
    - [x] Test lint errors fixed (unused variables, inline specifiers)
    - [x] Missing edge case tests added (tab, self-close, entities, CRLF)
    - [x] Benchmark GC annotations added for tokenizer
    - [x] .agents/ files updated (PROJECT, PROGRESS, TASKS)
    - [x] `deno task test` passes (253 tests)

- [ ] T05: Implement block parser (Phase 3)
  - Why: Block-level structure is the next layer above the tokenizer
  - Done when:
    - [ ] `block_parser.ts` exports `blockEvents(source, tokens)` generator
    - [ ] Headings: `== Title ==` emits enter/exit heading with level prop
    - [ ] Paragraphs: plain text lines accumulate into paragraph blocks
    - [ ] Bullet lists: `*`, `**` with nesting and list-item events
    - [ ] Ordered lists: `#`, `##` with nesting and list-item events
    - [ ] Definition lists: `;` term, `:` description with nesting
    - [ ] Tables: `{|`, `|}`, `|-`, `|+`, `|`, `||`, `!`, `!!`
    - [ ] Thematic breaks: `----` emits enter/exit thematic-break
    - [ ] Preformatted: leading space emits preformatted block
    - [ ] Event well-formedness: every enter has matching exit
    - [ ] Never-throw: any token stream produces valid events
    - [ ] Property-based fuzz tests with fast-check
    - [ ] `deno task test` passes
    - [ ] `mod.ts` re-exports `blockEvents`

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
