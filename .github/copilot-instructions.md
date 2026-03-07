# Repository-wide Copilot Instructions

## What this file is for

This file is the repo-wide base instruction layer.

Use it for:
- repository context
- architecture understanding
- global reasoning and writing expectations
- safety and correctness defaults

More specific instructions live under `.github/instructions/` and apply by file pattern or task type.
When a more specific instruction file applies, follow that file for the scoped task and use this file as the fallback base.

Do not duplicate specialized commit, changelog, or file-pattern-specific rules here unless they are truly repo-wide.

## What this project is

This repository builds a standards-aligned wikitext parser and related tooling.

Current product focus is still the wikitext parser itself. Use wikitext as the
proving ground for parser primitives, recovery behavior, offsets, streaming,
and session design before generalizing the architecture further.

Treat the parser as one deliberately simple workflow step in a larger future
document system, not as the whole product. It turns source text into tokens,
events, trees, and later session state that downstream tools can consume.

Longer-term, the same primitives may grow into a profile-driven structured
document engine that can support richer CMS blocks, additional markup and
rich-text families, collaborative editing, offline or local sync, and
LLM-oriented workflows. Treat that as future direction, not current scope.

When ecosystem compatibility matters, prefer adapters at the edge. The core
runtime should stay native to this project and optimized for event streams,
incremental work, and profile-driven behavior. Unified ecosystem support is
valuable, but should come through unist-compatible exports and optional unified
adapters until native runtime equivalents exist.

The architecture is event-stream-first. Events are the fundamental output.
ASTs, HTML, and other outputs are consumers built on top of the event stream.

## Architecture overview

```text
TextSource ─► Tokenizer ─► Event Stream ─► [Consumer]
                 │                              │
                 │   charCodeAt scanner         ├─► buildTree()    → WikistRoot
                 │   Generator<Token>           ├─► compileHtml()  → string
                 │                              ├─► filterEvents() → events
                 │                              └─► directConsumer → callback
                 │
                 └─► raw token stream (lowest cost)
```

The pipeline accepts any `TextSource`. Plain `string` satisfies the interface.

Events are range-first. Text events carry offset ranges into the source instead of eagerly extracted strings.

Core streaming modes:

* `outlineEvents(input)`: block-only, no inline parsing
* `events(input)`: full enter/exit/text event stream
* `parseChunked(chunks)`: progressive completed block nodes

## Non-negotiable parser contracts

* Event well-formedness: every `enter(X)` has a matching `exit(X)` with proper nesting.
* UTF-16 offsets: `position.offset` uses UTF-16 code unit indexing.
* Never throw: the parser produces a valid result for any input.
* Determinism: same input and same config produce the same output.

## Writing and explanation style

* Use familiar language that a JavaScript or TypeScript developer with about 2 to 3 years of experience would likely understand on first read.
* Do not assume parser, compiler, or formal language theory background unless the task clearly requires it.
* Do not replace one abstract phrase with another abstract phrase and call it clarity.
* Do not swap one hard word for another and call that plain English.
* When explaining a hard idea, start with concrete technical behavior from this repo or task.
* Ground explanations in at least one concrete anchor such as:

  * a real code path
  * a concrete input or output
  * a token or marker sequence
  * a bug or failure mode
  * a performance or allocation cost
  * a downstream effect for callers, maintainers, or consumers
* Explain what happens first, then why it matters here, then introduce the technical name only if it still helps.
* If a technical term such as `lexical`, `invariant`, or `delimiter` is necessary, explain what it means in this codebase and why it matters here.
* Use a real-world metaphor only when direct technical grounding still is not enough.
* Keep metaphors brief and accurate.
* After using a metaphor, return to the real technical behavior before moving on.
* Diagrams must match real behavior in the implementation or spec. Do not simplify them into something that teaches the wrong thing.
* Avoid em dashes in prose.

## Default operating mode

* Be explicit and high-signal.
* Prefer the smallest correct change first.
* Do not invent files, APIs, config, behavior, or guarantees that are not visible in the repo.
* If something is unclear, state the assumption and give a concrete verification step.
* Prefer established standards and conventions when they fit the problem.
* Call out trade-offs when multiple valid approaches exist.
* Optimize for maintainability, clarity, reproducibility, and educational value.
* Verify diagrams, examples, and explanatory claims against the implementation before presenting them as fact.

## Safety and correctness

* Default to least privilege.
* Avoid unsafe patterns such as string-built SQL, unsafe eval, weak crypto, or hidden trust assumptions.
* Do not leak secrets or credentials in logs, examples, or test fixtures.
* Call out trust boundaries around auth, permissions, parsing, and untrusted input.

## Commands

```bash
deno task test
deno task bench
deno doc --lint mod.ts
```

Run `deno doc --lint mod.ts` after any change to the public API surface or its documentation.

## Instruction routing

More specific instructions live under `.github/instructions/` and apply by file pattern or task type. Follow those files when they apply.

Examples:

* docs-writing instructions for docs, comments, and TSDoc work
* commit-writing instructions for commit messages
* changelog-writing instructions for changelog entries and release notes