# Repository-wide Copilot Instructions

## What this project is

This repository builds a standards-aligned wikitext parser and related tooling.

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

Events are range-first. Text events carry offset ranges into the source instead
of eagerly extracted strings.

Core streaming modes:

* `outlineEvents(input)`: block-only, no inline parsing
* `events(input)`: full enter/exit/text event stream
* `parseChunked(chunks)`: progressive completed block nodes

## Writing and explanation style

* Use familiar language that a reasonably experienced JavaScript or TypeScript developer would understand without pausing.
* Do not swap one hard word for another and call that plain English.
* If you need a technical term, explain the concrete behavior first, then introduce the term if it still helps.
* Ground abstract explanations in something the reader can picture here: a code path, a marker sequence, a bug, a performance cost, or a downstream benefit.
* When using a technical term such as `lexical`, `invariant`, or `delimiter`, explain what that means in this codebase, not just in theory.
* Diagrams must match real behavior in the implementation or spec. Do not simplify them into something that teaches the wrong thing.

## Non-negotiable parser contracts

* Event well-formedness: every `enter(X)` has a matching `exit(X)` with proper nesting.
* UTF-16 offsets: `position.offset` uses UTF-16 code unit indexing.
* Never throw: the parser produces a valid result for any input.
* Determinism: same input and same config produce the same output.

## Default operating mode

* Be explicit and high-signal.
* Prefer the smallest correct change first.
* Do not invent files, APIs, config, or behavior that are not visible in the repo.
* If something is unclear, state the assumption and give a concrete verification step.
* Prefer established standards and conventions when they fit the problem.
* Call out trade-offs when multiple valid approaches exist.
* Optimize for maintainability, clarity, reproducibility, and educational value.
* Use plain English in docs, comments, TSDoc, PR prose, and explanations.
* When technical or abstract terms are necessary, define them in grounded language that starts from something concrete the unfamiliar reader can picture.
* Do not replace one abstract phrase with another abstract phrase and call it clarity.
* Tie abstractions to real behavior, cost, failure mode, or downstream benefit.
* Verify diagrams, examples, and explanatory claims against the implementation before presenting them as fact.
* Avoid em dashes in prose.

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

Run `deno doc --lint mod.ts` after any change to the public API surface or its
documentation.

## Where focused rules live

More specific instructions live under `.github/instructions/` and apply by file
pattern. Follow those files when working in matching paths.
