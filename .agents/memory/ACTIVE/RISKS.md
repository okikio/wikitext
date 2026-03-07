# Risks

## Known risks

- **Apostrophe run disambiguation**: MediaWiki's apostrophe heuristic for
  bold/italic is complex and under-documented. May need iterative refinement
  against real corpus.
- **Cross-block template spans**: `{{ ... \n ... }}` spans block boundaries,
  complicating incremental reparsing. State snapshots are designed to handle
  this but need thorough testing.
- **Wikitext has no formal grammar**: MediaWiki's parser is the spec. Edge
  cases are discovered empirically, not derived from rules.
- **TextSource perf on non-string backing**: Rope/CRDT implementations of
  `charCodeAt()` may have non-trivial overhead per call. The tokenizer's inner
  loop calls it on every character. Cursor-based amortization is needed.
- **Session scope creep**: Session API risks becoming a God object. Each phase
  should add minimal surface area. Session delegates to pipeline modules.
- **Stability frontier edge cases**: Wikitext delimiters (`{{`, `[[`, `{|`)
  can stay open across many blocks, pushing the frontier far back during
  streaming. May need heuristic timeout or depth limit.
- **Leaf coverage invariant**: Tree invariant #6 (source coverage) relaxed:
  delimiter characters (`'''`, `[[`, `{{`, etc.) are covered by parent node
  position ranges but not by dedicated leaf nodes. Consumers that iterate only
  leaf positions will see gaps at delimiter boundaries. Must document clearly
  and test edge cases.
- **Cross-mode consistency**: The three streaming modes (outlineEvents,
  events, parse) must agree on block-level structure. Structural disagreement
  between modes is a bug. Requires systematic cross-mode test coverage.
- **Streaming replacement semantics**: Provisional tail events "may be
  replaced" but the replacement model is not yet proven in implementation.
  Model A (tail reset) may be too expensive for large provisional tails;
  Model B (patch stream) adds consumer complexity. Defer final choice to
  Phase 6 implementation.
- **Lossy string fields**: `target`, `name`, `attributes` fields on nodes
  are extracted convenience strings that may lose comments, whitespace, or
  nested markup. Clashes with source-faithfulness claims. Mitigation:
  `position` offsets are always authoritative; document string fields as
  convenience only.
- **ParserFunction/MagicWord classification**: Without MediaWiki config,
  the parser cannot distinguish `{{PAGENAME}}` (magic word) from
  `{{SomeTemplate}}` (template). Default: parse all non-`#`-prefixed as
  Template. Risk: profiles may need a word list, adding configuration
  burden.
- **Heading close marker token mismatch (discovered, resolved)**: The
  tokenizer emits `EQUALS` (not `HEADING_MARKER_CLOSE`) for trailing `==`
  in headings. The block parser originally checked for `HEADING_MARKER_CLOSE`
  inline and missed close markers. Resolved by rewriting to a
  collect-then-trim strategy. Future inline parser work should verify
  similar assumptions about token types.
- **State snapshots deferred**: Block boundary state snapshots (needed for
  incremental reparsing in Phase 7) are not yet recorded. A `TODO(Phase 7)`
  comment marks the insertion point in `block_parser.ts`. Until Phase 7,
  incremental reparsing is not possible.

## Mitigations

- Fuzz testing from Phase 3 catches never-throw violations early
- Corpus regression from Phase 5 catches behavioral regressions
- Syntax-first scope avoids getting stuck on MediaWiki quirks
- State snapshots at block boundaries enable safe incremental reparsing
- `TextSource` MVP uses plain `string`: perf regression only possible when
  switching to a non-string backing store
- Session API reviewed phase-by-phase to prevent scope inflation

## Follow-ups

- Build conformance suite from MediaWiki parser test cases
- Run against mwparserfromhell output for template/link extraction parity
- Profile memory allocation on large articles (100K+ chars)
- Benchmark `TextSource.charCodeAt()` perf with rope backing vs string
- Evaluate Anchor API scope (core vs separate package) at Phase 8
