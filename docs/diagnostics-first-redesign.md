# Diagnostics-First Parser Redesign

Status: the first public realignment has landed. The parser now exposes
`parseStrictWithDiagnostics()` and `buildTreeStrict()`, and event-stream diagnostics are
opt-in by default. The sections below still capture the reasoning and the
remaining architectural direction behind that shift.

If you want the smaller architecture-facing explanation first, start with:

- [docs/architecture/diagnostics-first.md](./architecture/diagnostics-first.md)
- [docs/architecture/choosing-a-parser-result.md](./architecture/choosing-a-parser-result.md)
- [docs/architecture/malformed-input.md](./architecture/malformed-input.md)
- [docs/architecture/api-direction.md](./architecture/api-direction.md)
- [docs/architecture/utility-first.md](./architecture/utility-first.md)
- [docs/architecture/performance.md](./architecture/performance.md)
- [docs/architecture/parser-contracts.md](./architecture/parser-contracts.md)

This note audits the current parser surface against the intended
diagnostics-first model and proposes a concrete redesign.

Use this note for the deeper design argument, the migration pressure, the
remaining rollout questions, and the open questions. For the shorter
architecture explanation, use
[docs/architecture/diagnostics-first.md](./architecture/diagnostics-first.md).

The goal is not to remove tolerant defaults. The goal is to separate three
different ideas that have drifted together in the current API:

- detecting malformed input
- continuing parsing without throwing
- materializing one particular recovered tree shape

That separation matters because the parser should be explicit about its
defaults without compelling every consumer to accept the parser's own recovery
materialization.

## Problem

The current public story treats recovery as a parser-owned output lane.

```text
current public framing

source
  ├─► parse()                -> default tree
  ├─► parseWithDiagnostics() -> default tree + diagnostics
  └─► parseWithRecovery()    -> default tree + diagnostics + recovery summary
```

The intended model is:

- diagnostics are the primitive
- the parser may continue internally so it does not throw
- recovery materialization is an optional consumer response to diagnostics
- downstream consumers may expand parser diagnostics into their own
  domain-specific diagnostics

In other words, `never throw` means the parser keeps going and preserves the
problem. It does not mean the parser must publish one canonical recovered tree
shape as the meaning of malformed input.

The current code still has useful pieces of that original design. In
[events.ts](events.ts), error events are optional, structured, and already
described as consumer-facing signals that can be logged, surfaced, ignored, or
expanded. The drift happens higher in the stack, where the parser and tree
builder elevate recovery materialization into first-class parser lanes.

## Goals

- Keep the parser never-throw contract.
- Stay close to HTML-like parsing with explicit commitment points and tolerant
  defaults.
- Make diagnostics the primary public primitive for malformed input.
- Keep diagnostic emission optional so consumers that do not want diagnostics
  do not pay for them.
- Surface recovery materialization options explicitly.
- Avoid compelling consumers to accept a recovered tree if they only want
  diagnostics, source-backed text, or their own downstream recovery logic.
- Preserve the ability for downstream tools such as renderers and editors to
  emit their own diagnostics on top of parser diagnostics.

## Non-goals

- Remove all internal continuation heuristics from the parser.
- Make malformed input fatal.
- Remove tolerant default behavior for consumers that do want it.
- Solve edit-stable diagnostic anchors in this redesign.

## Current Drift

### The event model is mostly aligned

The event layer in [events.ts](events.ts) is already close to the intended
shape:

- diagnostics are optional `error` events
- diagnostic codes are stable parser-owned facts
- diagnostic metadata is open enough for downstream consumers
- docs already describe consumer choice as the point of those diagnostics

This is the strongest part of the current design and should remain the base
primitive.

### The parser API still makes materialization feel more parser-owned than it should

The orchestration API in [parse.ts](parse.ts) currently frames the parser as
several top-level tree lanes:

- `parse()` returns the default HTML-like tree
- `parseWithDiagnostics()` returns that same default tree plus diagnostics
- `parseStrictWithDiagnostics()` returns the source-strict tree plus diagnostics
- `parseWithRecovery()` returns the default tree plus diagnostics and `recovered`

That is better than the older framing, because diagnostics are now opt-in by
default and `parseStrictWithDiagnostics()` names the conservative lane more honestly. But it
still makes materialization feel like a parser-owned truth instead of a
consumer policy layered over the same syntax findings.

### The tree builder currently owns recovery-shape policy

[tree_builder.ts](tree_builder.ts) currently exposes `TreeBuildMode` as
`'strict' | 'loose'` and documents those modes as recovery-shape policies.

That creates two problems:

- tree materialization policy is presented as if it were part of parsing truth
- diagnostics and recovered tree shape are coupled in one API family

The addition of `buildTreeWithLooseDiagnostics()` helps operationally because
it separates `recovered` from `diagnostics`, but it still keeps the public
story centered on parser-owned recovery shape.

### The current docs teach the drift as architecture

[docs/architecture.md](docs/architecture.md) and [readme.md](readme.md)
currently describe `strict` and `loose` as top-level parser choices and teach
the tree lanes as the main way to think about malformed input.

That is the opposite of the intended mental model. It teaches readers that the
parser owns recovery semantics, when the intended design is that the parser
owns diagnostics and continuation, and consumers own recovery responses.

### Tests currently lock in parser-owned recovery semantics

[parse_test.ts](parse_test.ts) and [session_test.ts](session_test.ts) assert
that:

- `parseWithDiagnostics()` and `parseWithRecovery()` are separate wrappers even
  though they now share the same default tree shape
- strict versus loose tree shape is a parser-level distinction
- recovery-specific wrapper nodes are part of the parser's promised result

Those tests are useful because they show the exact behavioral drift. They will
need to move as the API is realigned.

## Design Distinction To Restore

The core distinction should be:

```text
diagnostic      = factual parser finding
continuation    = minimal internal behavior that lets parsing proceed
materialization = consumer-visible choice about how to represent malformed input
```

That gives a cleaner mental model:

```text
source
  ├─► parser detects malformed input
  ├─► parser records a diagnostic when requested
  ├─► parser continues internally so it never throws
  └─► consumer chooses whether to:
        - ignore the diagnostic
        - surface the diagnostic
        - materialize a tolerant tree
        - materialize a conservative tree
        - emit richer downstream diagnostics
```

The parser still needs continuation heuristics. A block parser cannot keep
streaming without making some local choice when a table never closes or an
event stream ends with open frames. But those choices should be treated as
survivability mechanics, not as the only public recovery meaning.

## Proposal

### 1. Make diagnostics the primary malformed-input contract

Keep parser diagnostics as structured event-layer facts.

The parser should continue to emit stable `DiagnosticCode` values and optional
details, but the docs should stop describing those diagnostics as evidence of a
parser-owned recovery lane. They are parser findings that consumers can act on
or translate.

### 2. Rename the internal concept from recovery to continuation where possible

Inside parser implementation docs and comments, prefer `continuation` for the
minimum logic required to keep scanning or keep the event stream well-formed.

Use `recovery` for consumer-visible responses to diagnostics or for explicit
materialization helpers that are intentionally opt-in.

This is especially important in:

- [block_parser.ts](block_parser.ts)
- [inline_parser.ts](inline_parser.ts)
- [tree_builder.ts](tree_builder.ts)

### 3. Move tree shape choices out of the parser-success narrative

Tree shape should be described as a materialization policy, not as the parser's
acceptance or recovery mode.

A clearer conceptual split is:

- parser options decide whether diagnostics are emitted
- materializer options decide how malformed regions are represented

That means the parser surface should stop teaching `strict` and `loose` as the
main mental model for malformed input.

### 4. Keep diagnostic emission optional and explicit

This part is already directionally correct in the implementation and should be
preserved.

If a caller says they do not want diagnostics, block and inline parsers should
not emit diagnostic events at all.

That cost model should be made explicit in the public API:

```text
diagnostics off
  -> no diagnostic events emitted
  -> no diagnostic collection
  -> cheapest parse lane

diagnostics on
  -> diagnostic events emitted
  -> downstream recovery-aware materializers may consume them
  -> caller accepts the added allocation and processing cost
```

### 5. Reframe public tree APIs around materialization policy

Replace the current recovery-centered API story with a diagnostics-first,
materialization-second story.

One concrete direction:

```ts
interface ParseOptions {
  readonly diagnostics?: boolean;
  readonly materialization?: 'default-html-like' | 'source-strict';
}

interface ParseOutput {
  readonly tree: WikistRoot;
  readonly diagnostics?: readonly ParseDiagnostic[];
}
```

With convenience wrappers if desired:

- `parse(source)`
  default HTML-like materialization, no diagnostics
- `parseWithDiagnostics(source)`
  default HTML-like materialization plus diagnostics
- `parseStrictWithDiagnostics(source)`
  source-strict materialization plus diagnostics by default

The important change is not the exact names. The important change is that the
API no longer teaches "diagnostics lane versus recovery lane" as if those were
peer parser truths. Instead it teaches:

- do you want diagnostics?
- if yes, how do you want malformed regions materialized?

For that public-facing option shape, `diagnostics` should be the public name.
It is shorter, and it describes the caller's choice instead of the
implementation detail of whether diagnostic events are being emitted
internally.

### 6. Treat explicit recovery materialization as an opt-in helper layer

If the package wants to preserve strong support for tolerant consumers, keep
that support as explicit helpers rather than as the parser's main malformed-
input identity.

For example:

- `buildTree(events, { source })`
  default HTML-like materialization
- `buildTreeWithDiagnostics(events, { source })`
  same materialization plus anchored diagnostics
- `materializeDiagnostics(events, { source, policy: 'source-strict' })`
  conservative materialization for linting or editor diagnostics
- `materializeDiagnostics(events, { source, policy: 'default-html-like' })`
  tolerant materialization for rendering

This keeps recovery materialization surfaced, explicit, and optional.

### 7. Add materialization hints to diagnostics instead of baking one response into the tree API

If parser diagnostics need to help consumers choose a response, add stable
metadata that describes the kind of malformed region without forcing one public
repair.

For example, the diagnostic payload could eventually carry fields such as:

- `code`
- `source`
- `details`
- `continuation_kind`
- `suggested_materializations`

That would let a renderer, editor, or linter make an informed choice without
requiring the parser to publish one canonical recovered tree for every case.

This should stay conservative. The parser should expose facts and hints, not a
large strategy engine.

### 8. Leave room for a true `analyze()` lane

There is one stronger diagnostics-first option that the current public API does
not fully provide yet.

Today the parser offers:

- a cheap tree with no preserved diagnostics
- the default tolerant tree with diagnostics
- a conservative tree with diagnostics

What it does not fully offer yet is this:

```text
diagnostics and possible recoveries are exposed
but the caller chooses the final materialization later
```

That would be more diagnostics-first than `parseStrictWithDiagnostics()`. `parseStrictWithDiagnostics()`
still chooses a final conservative tree policy on the caller's behalf. A true
`analyze()` lane would expose findings first and make the final repair policy
more explicitly caller-owned.

The practical shape matters here. The best public answer is probably not just a
bare one-shot event generator. The parser is already event-stream-first, but a
control-heavy caller often needs more than one pass over the same information.

That caller may need to:

- inspect diagnostics before choosing a tree policy
- compare more than one candidate repair path
- materialize both tolerant and conservative trees from the same parse
- cache findings inside a session or incremental workflow

That points toward a replayable findings utility built on the event stream.
Conceptually:

```text
source
  -> analyze()
       -> findings
            - replayable events
            - diagnostics
      - recovery data
  -> materialize(findings, tolerant)
  -> materialize(findings, conservative)
```

This should stay an open design question until the package has a clearer model
for what a "possible recovery" surface actually looks like and how much of that
surface belongs to the parser instead of later consumers.

## Trust rules and practical contracts

The practical trust rules now live in the smaller architecture notes so this
design note does not have to reteach the same ground every time.

- [docs/architecture/parser-contracts.md](./architecture/parser-contracts.md)
  covers the invariants the parser should preserve.
- [docs/architecture/malformed-input.md](./architecture/malformed-input.md)
  covers commitment points and malformed-input behavior.
- [docs/architecture/diagnostic-anchors.md](./architecture/diagnostic-anchors.md)
  covers how diagnostics point back into the final tree.

## How To Tell Whether The Block/Inline Split Is A Problem

The existence of two parser stages is not evidence of a design problem. The
useful question is whether the handoff causes correctness drift or measurable
extra work.

Check it in this order:

1. Correctness contract:
   `outlineEvents()`, `events()`, and `parse()` should agree on block
   structure for the same input in the default tolerant lane.
2. Handoff behavior:
   merged block text groups should not trim content, invent boundaries, or
   force the inline parser to reconstruct information the block parser already
   knew.
3. Cost profile:
   measure text-event counts, merged text-group counts, inline candidate
   scans, allocations, and total throughput on prose-heavy, syntax-heavy, and
   malformed corpora.
4. Change threshold:
   only collapse the stages or redesign the boundary if the split causes a
   real correctness bug or a benchmarked throughput or allocation regression.

The useful comparison is not "two stages versus one stage" in the abstract.
It is "does this handoff preserve the contracts while reducing repeated work?"

```text
bad split
  block parser fragments text
  -> inline parser has to reconstruct the same logical group
  -> correctness or cost regresses

good split
  block parser emits one accurate contiguous prose range
  -> inline parser scans once for real inline openers
  -> contracts stay intact and work drops
```

That is why the next verification step should be contract tests plus focused
benchmarks, not a premature rewrite into one monolithic parser.

## Primitive-first extension model

The longer architecture-facing explanation now lives in
[docs/architecture/utility-first.md](./architecture/utility-first.md).

The short version here is still important: the redesign works better if the
parser leads with stable primitives and downstream composition instead of a deep
hook surface that freezes hot-path behavior too early.

## Ambiguity hotspots worth hardening next

The narrow handoff and bare-URL follow-up now lives in
[docs/handoff-and-bare-url-notes.md](./handoff-and-bare-url-notes.md).

That keeps this redesign note focused on the tree and diagnostics model instead
of turning it into a second all-purpose architecture file.

## HTML-Like Parsing Guidance

Staying close to HTML-like parsing still fits this redesign.

The parser should continue to use explicit commitment points. The existing
HTML-like tag rule in [inline_parser.ts](inline_parser.ts) is a good example:

- before the opener reaches `>`, do not commit a real tag node
- after the opener reaches `>`, the opener is structurally real
- if the close tag never arrives, emit a diagnostic and let materializers
  choose how much tolerant structure to preserve

That is a good default because it is explicit and predictable. What should
change is not the commitment rule. What should change is the public framing of
who owns the final recovery materialization.

## Concrete API direction

The future public-surface cleanup now lives in
[docs/architecture/api-direction.md](./architecture/api-direction.md).

That keeps this redesign note focused on the larger architectural problem while
still preserving one place for the future wrapper and option-shape discussion.

## Performance Model

This redesign keeps the fast path clear.

```text
cheap lane
  diagnostics off
  -> tokenizer
  -> block parser without diagnostic events
  -> inline parser without diagnostic events
  -> default materialization if requested

diagnostics lane
  diagnostics on
  -> tokenizer
  -> block parser with diagnostic events
  -> inline parser with diagnostic events
  -> diagnostics-preserving materialization if requested
```

This matches the intended trade-off:

- consumers that do not want diagnostics do not pay for them
- consumers that want diagnostics and recovery-aware handling accept the cost

That cost model should be explicit in docs, code comments, and session cache
structure.

## Rollout Plan

1. Rewrite docs so diagnostics are the primary malformed-input concept and
   tree shape is described as materialization policy.
2. Deprecate recovery-centered names where they teach the wrong model,
   especially `parseWithRecovery()` as the main public malformed-input lane.
3. Introduce a findings utility and tree APIs that separate diagnostic emission
  from materialization policy.
4. Move tests from "parser owns recovery tree semantics" to
   "materializer policy changes representation of the same parser findings".
5. Keep compatibility wrappers temporarily if migration cost matters.
6. Add contract tests for cross-mode block consistency, commitment-point
  behavior, and the default-versus-source-strict trust boundaries.
7. Add focused benchmarks or counters around the block-to-inline handoff before
  reconsidering the two-stage design.

This section stays here for now because it is still part of the redesign
discussion, not yet a settled implementation plan.

## Open Questions

- Should the default `events()` lane include diagnostics, or should the
  cheapest no-diagnostics lane be the default and diagnostics require explicit
  opt-in?
- Should the package keep a tolerant convenience wrapper equivalent to the
  current `parseWithRecovery()`, or should that become a more clearly named
  materialization helper?
- Should the `analyze()` lane expose replayable arrays, a session-backed view, or
  another reusable iterable shape?
- How much structured response metadata should diagnostics carry before the
  parser starts looking like a strategy engine?
- Should tree-stage findings such as mismatched exits remain public parser
  diagnostics, or be treated as internal materializer diagnostics unless the
  caller explicitly requests low-level stream integrity facts?
- How narrow should the core bare-URL recognizer stay before profiles or
  downstream consumers take over richer URL or IRI handling?

## Summary

The current implementation already has the right low-level foundation:
optional structured diagnostics and explicit cost gates for emitting them.

The drift is mainly in the public framing and the tree APIs. They currently
teach recovery materialization as a parser-owned lane.

The redesign should restore this rule:

- the parser owns diagnostics and continuation
- consumers own whether and how malformed input is materially recovered

That keeps the parser explicit, tolerant, HTML-like, and performant without
forcing downstream consumers into one recovery worldview.