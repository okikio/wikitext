# Corpus Matrix

This note turns the parser-testing categories into a concrete matrix backed by
real upstream sources.

The goal is not to vendor every upstream test file wholesale. The goal is to
borrow pressure from the ecosystems that already carry years of parser bugs,
then reduce that pressure into stable local fixtures that fit this repo's own
contracts.

## Why this exists

"Add more tests" is too vague for a parser.

The useful questions are:

1. Which kind of failure is this corpus good at catching?
2. Which upstream project already carries those cases?
3. Which local API should prove the contract here?

This matrix answers those questions so future test additions stay deliberate.

## Upstream anchors

These are the highest-value upstream sources to mine first.

| Source | Why it matters | Best use here |
| --- | --- | --- |
| MediaWiki core `tests/parser/parserTests.txt` and related parser-test files | The largest public body of real wikitext parser regressions and canonical examples. Covers ordinary syntax, malformed input, extension coordination, and expected HTML output. | Canonical syntax, malformed-but-committed markup, compatibility snapshots |
| MediaWiki parser-test format docs | Documents file structure, options, hooks, extension requirements, article setup, and Parsoid-compatible modes. | Mapping upstream cases into local categories and preserving intent |
| Parsoid parser tests | Adds round-trip, HTML normalization, html2wt, wt2wt, and selser-style edited-round-trip pressure. | Round-trip, tolerant structural preservation, future stringify and session work |
| html5lib tokenizer tests | Shared HTML tokenizer conformance data, especially useful for commitment and error-taxonomy thinking around tags and comments. | HTML-like opener commitment, malformed tag and comment cases |
| html5lib tree-construction tests | Shared HTML tree-construction cases that stress recovery decisions after commitment. | Diagnostics taxonomy and tolerant-versus-conservative materialization design |
| MediaWiki Cite extension tests | Real `<ref>` and `<references>` boundary behavior, including malformed and nested reference scenarios. | Extension-boundary coverage for ref-like tags |
| MediaWiki ParserFunctions tests | Real `{{#...}}` parser-function pressure and configuration-sensitive branching syntax. | Extension-boundary coverage for parser functions and nested template-like forms |

## Category matrix

This is the working test taxonomy for the repo.

| Category | What it should prove | Upstream source | Local test home |
| --- | --- | --- | --- |
| Canonical block syntax | Headings, lists, tables, redirects, pre blocks, and paragraphs produce stable structure. | MediaWiki core parser tests | `block_parser_test.ts`, `parse_test.ts` |
| Canonical inline syntax | Links, templates, emphasis, comments, tags, and entities keep correct ranges and nesting. | MediaWiki core parser tests, reduced real-wiki samples | `inline_parser_test.ts`, `events_test.ts` |
| Malformed but committed | Once a construct reaches its commitment point, the default lane keeps structural intent and emits diagnostics. | MediaWiki core parser tests, Parsoid tests | `parse_test.ts`, `session_test.ts` |
| Malformed before commitment | If the opener never commits, all lanes stay source-backed text. | html5lib tokenizer ideas, reduced MediaWiki cases | `inline_parser_test.ts`, `parse_test.ts` |
| Default versus strict materialization | The same parser findings can yield different final tree shapes without changing diagnostics. | Local reduced fixtures derived from upstream malformed cases | `parse_test.ts`, `session_test.ts` |
| Extension boundaries | `<ref>`, `<references>`, parser functions, and other extension-like constructs stay isolated as explicit feature pressure. | Cite, ParserFunctions | dedicated extension-focused tests or expanded `inline_parser_test.ts` |
| Round-trip and edited round-trip | Source can survive parse and later stringify or selective serialization work without losing committed structure. | Parsoid `wt2wt`, `html2wt`, `selser` modes | future `stringify` and `session` tests |
| HTML-like tag commitment | Tag openers, attributes, comments, and mismatched closes follow disciplined tolerant behavior. | html5lib tokenizer and tree-construction suites | `inline_parser_test.ts` |
| Fuzz and adversarial | Parser never throws and still preserves core invariants under hostile input. | Generated fuzz plus minimized failures | `*_test.ts` property tests |

## Concrete first batch

These are the first cases worth reducing into local fixtures.

### MediaWiki core

- table openers that never close with `|}`
- nested tables inside cells
- heading and list adjacency cases
- malformed attribute and table-cell syntax
- nested template and link interactions
- apostrophe-heavy emphasis ambiguity

### Parsoid

- cases where tolerant HTML-like structure should survive malformed closure
- round-trip pairs where a structural intent must remain visible in `wt2wt`
- edited HTML cases that later matter for `selser`-style thinking

### html5lib

- tag openers that never reach `>`
- comments with malformed open and close sequences
- mismatched or stray end tags after commitment
- attribute-shape edge cases that distinguish text from real tag state

### MediaWiki extensions

- Cite cases for unclosed `<ref>`, nested ref-like content, and `<references>`
  placement
- ParserFunctions cases for nested `{{#if:...}}`, `{{#switch:...}}`, and mixed
  template or parser-function boundaries

## How to import cases without making the suite brittle

Do not mirror upstream files one-to-one.

Use this reduction pipeline instead:

```text
upstream corpus
  -> identify one parser behavior worth preserving
  -> reduce to the smallest input that still proves it
  -> assert on local contracts
  -> keep a source note pointing back to the upstream family
```

That matters because this repo is not promising byte-for-byte MediaWiki or
Parsoid output yet. It is promising its own contracts:

- never throw
- UTF-16 offsets stay authoritative
- event nesting stays well-formed
- default tolerant structure stays available after committed malformed input
- strict materialization stays more conservative without changing diagnostics

## Local contract mapping

Each category should primarily test one public contract.

| Contract | Best API to test |
| --- | --- |
| Token boundaries and source slicing | `tokens()` |
| Block structure stability | `outlineEvents()`, `events()`, `parse()` |
| Inline nesting and commitment | `events()` |
| Diagnostics presence and codes | `events({ include_diagnostics: true })`, `parseWithDiagnostics()` |
| Materialization policy differences | `parseWithDiagnostics()`, `parseStrict()`, `parseWithRecovery()` |
| Session cache equivalence | `createSession()` APIs |
| Never-throw invariant | property tests and reduced fuzz fixtures |

## Licensing and hygiene

Treat upstream corpora as references first.

- Prefer reduced local fixtures over copying large upstream files.
- If a full imported fixture set ever becomes necessary, review its license and
  keep provenance explicit.
- Preserve a short note describing which upstream family a reduced fixture came
  from and what behavior it is meant to prove.

## Suggested rollout

1. Add a small reduced fixture batch for malformed tables, malformed ref tags,
   and nested parser-function or template cases.
2. Add block-structure consistency assertions for those fixtures across
   `outlineEvents()`, `events()`, and `parse()`.
3. Add paired default-versus-strict assertions for committed malformed inputs.
4. Add a separate future batch for Parsoid-inspired round-trip and edited-
   round-trip cases once `stringify()` and later session phases land.

That gives the repo a real corpus strategy without pretending the current
surface is already a MediaWiki clone.