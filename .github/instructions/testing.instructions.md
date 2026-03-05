---
description: Test quality standards for this repo
applyTo: "**/*_test.ts,**/*.test.ts"
---

# Testing Rules

## Tools

| Role                              | Import                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| Test runner                       | `deno test --trace-leaks --v8-flags=--expose-gc` (via `deno task test`) |
| BDD structure (`describe` / `it`) | `jsr:@std/testing/bdd`                                                  |
| Assertions                        | `jsr:@std/expect` (`expect`)                                            |
| Property-based testing            | `npm:fast-check` (`fc`)                                                 |

Imports follow this pattern at the top of every test file:

```ts
import { describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import * as fc from "npm:fast-check";
```

Always run tests with `deno task test`: the flags `--trace-leaks` and
`--v8-flags=--expose-gc` are required to catch resource leaks and enable GC
control in property-based tests.

## Core principle: test behavior, not implementation

Treat each module as a black box. Call the public API, assert on the output.
Never assert on internal state, private methods, or implementation details. A
refactor that preserves observable behavior must not break any test.

For the wikitext parser, this means testing through `parse()`, `events()`,
`outlineEvents()`, `stringify()`, and `tokens()`, not through internal parser
state.

## Test independence and determinism

- No shared mutable state between tests.
- No ordering dependencies: tests must pass in any order.
- No reliance on wall-clock time, random seeds, or external resources unless
  clearly isolated.
- One logical behavior per test. If a test description needs "and", split it.

## Clarity over DRYness

Tests are documentation. When a test fails, a developer should understand the
scenario immediately without chasing through helper abstractions.

Use the **AAA pattern** (Arrange, Act, Assert) for every test:

```ts
// Arrange: set up inputs
const input = "== Heading ==";

// Act: call the public API
const tree = parse(input);

// Assert: verify the observable output
expect(tree.children[0].type).toBe("heading");
expect(tree.children[0].depth).toBe(2);
```

Duplicating setup between two tests is acceptable when it makes each test
self-explanatory. Extract helpers only when they genuinely reduce noise without
obscuring intent.

## Property-based tests (fast-check)

Hand-written examples only cover cases you imagined. Property-based tests
generate hundreds of random inputs and verify invariants. For a parser library,
they are the highest-leverage test type.

Import fast-check via `npm:fast-check` and verify these invariants:

**Never-throw**: the parser produces a valid tree for any input:

```ts
fc.assert(
  fc.property(fc.string(), (s) => {
    const tree = parse(s);
    expect(tree.type).toBe("root");
  }),
);
```

**Round-trip stability**: parse then stringify then parse again yields the same
tree:

```ts
fc.assert(
  fc.property(wikitextArbitrary(), (s) => {
    const tree1 = parse(s);
    const tree2 = parse(stringify(tree1));
    expect(tree2).toEqual(tree1);
  }),
);
```

**Event well-formedness**: every `enter` has a matching `exit`, nesting is
balanced:

```ts
fc.assert(
  fc.property(fc.string(), (s) => {
    const stack: string[] = [];
    for (const evt of events(s)) {
      if (evt.type === "enter") stack.push(evt.nodeType);
      if (evt.type === "exit") expect(stack.pop()).toBe(evt.nodeType);
    }
    expect(stack).toEqual([]);
  }),
);
```

**Position monotonicity**: offsets never decrease within the event stream:

```ts
fc.assert(
  fc.property(fc.string(), (s) => {
    let lastOffset = 0;
    for (const evt of events(s)) {
      if (evt.position) {
        expect(evt.position.start.offset).toBeGreaterThanOrEqual(lastOffset);
        lastOffset = evt.position.start.offset;
      }
    }
  }),
);
```

**Token coverage**: tokens span every UTF-16 code unit of the input with no
gaps and no overlaps:

```ts
fc.assert(
  fc.property(fc.string(), (s) => {
    let coveredUpTo = 0;
    for (const tok of tokens(s)) {
      expect(tok.start).toBe(coveredUpTo);
      coveredUpTo = tok.end;
    }
    expect(coveredUpTo).toBe(s.length);
  }),
);
```

## Oracle / compatibility tests

Compare parser output against known-good references. Parse real Wikipedia
articles and snapshot the AST. Use these snapshots as regression tests:

```ts
const input = Deno.readTextFileSync("tests/corpus/earth.wikitext");
const tree = parse(input);
const snapshot = JSON.stringify(tree, null, 2);
// Compare against saved snapshot
expect(snapshot).toBe(
  Deno.readTextFileSync("tests/corpus/earth.snapshot.json"),
);
```

For template/link extraction, compare against mwparserfromhell output on the
same input when feasible.

## Boundary value tests

For any feature with structural boundaries, always test at the edges:

```ts
// Heading levels: 1 through 6, and beyond (7+ should fall back)
expect(parse("= H1 =").children[0].depth).toBe(1);
expect(parse("====== H6 ======").children[0].depth).toBe(6);

// Empty content between markers
expect(parse("== ==").children[0].type).toBe("heading");

// Single character content
expect(parse("== X ==").children[0].type).toBe("heading");
```

Test 0, 1, and 2 of any repeated element (list items, table rows, template
arguments) to catch off-by-one errors.

## Edge cases to always cover

These are often missed but expose real bugs:

- Unclosed bold/italic markers (`'''bold` without closing `'''`).
- Apostrophe runs of unusual lengths (1, 4, 6+).
- Nested templates inside wikilinks (`[[File:{{name}}.png]]`).
- Templates spanning multiple lines (`{{ ... \n ... }}`).
- Malformed tables (missing `|}`, `|-` outside table, nested tables).
- Mixed list markers (`*#:` combinations for nested mixed lists).
- Definition lists with colons in content (`; Term : Description : Extra`).
- Unclosed `[[` and `{{` treated as literal text.
- HTML tags: self-closing, void, unclosed, and nested.
- Nowiki/pre regions protecting content from parsing.
- Behavior switches (`__TOC__`, `__NOTOC__`).
- Signatures (`~~~`, `~~~~`, `~~~~~`).
- Redirects (`#REDIRECT [[Target]]`).
- Strings with `\0` (null bytes).
- Pure `\r` line endings (not just `\r\n`).
- Emojis and other astral Unicode characters (surrogate pairs).
- CJK characters and RTL text.
- Empty input (`''`), single newline, single space.
- Extremely long lines (10K+ characters).

## Anti-patterns to avoid

- **Asserting full multi-line string equality** when a structural assertion
  would be more robust. Prefer `assertStringIncludes`, line-count checks, or
  prefix/suffix assertions when exact output isn't what matters.
- **Mutation-blind assertions**: a test that runs a code path but never checks
  the return value provides false safety. Every `act` step must have an `assert`
  step that would fail if the output changed.
- **Over-abstraction in test helpers**: a helper that builds expected values
  programmatically using the same logic as the implementation is testing
  nothing. Expected values should be literals written by a human.
