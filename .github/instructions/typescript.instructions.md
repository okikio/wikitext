---
description: Deno + TypeScript standards for this repo
applyTo: "**/*.ts,**/*.tsx"
---

# TypeScript / Deno Rules

## Runtime and module model

- Assume Deno v2, strict TypeScript, and ESM.
- Keep modules tree-shakeable.
- Avoid top-level side effects unless they are clearly required.
- Avoid hidden global state.
- Avoid surprising initialization during import.

## Formatting

- Use single quotes for strings.
- Use tabs with a 2-space feel.
- Keep opening braces on the same line as declarations.

## Imports

- Separate type imports from value imports with `import type`.
- Use explicit file extensions.
- Group imports by role in this order:
  1. types
  2. runtime or external dependencies
  3. shared internal modules
  4. local modules

## API and type design

- Prefer explicit, narrow return types at module boundaries.
- Prefer `Iterable` and `AsyncIterable` in public APIs over arrays unless arrays are clearly the better fit.
- Avoid `any`. Prefer unions, generics, discriminated unions, and narrowing.
- Keep public keys stable unless an explicit migration is approved.

## Naming conventions

- AST node discriminants use `kebab-case`.
- Single-word discriminants stay lowercase.
- Public object and interface keys prefer `snake_case`.
- AST node types use `Wikist*` names.
- Event types use `*Event`.
- Type guards use `is*()`.
- Builder functions use lower camel case nouns.

Examples:
- `'thematic-break'`
- `'list-item'`
- `node_type`
- `start_offset`
- `WikistRoot`
- `TextEvent`
- `isHeading()`
- `heading(level, children)`

## Object copying

- Prefer `Object.assign(...)` over object spread when practical.
- Use spread only when it materially improves readability.

## Public API documentation bar

For every exported function, interface, type alias, and constant:

- Write TSDoc in plain English.
- Explain why it exists, not just what it is.
- Ground the explanation in the problem being solved, the approach taken, and the assumptions or edge cases.
- Every field of an exported interface or public type needs its own JSDoc comment.
- Any type referenced in a public signature must itself be exported.

For non-trivial public APIs:

- Include at least two examples:
  - one common path
  - one edge case or configuration variant

Every `@example` block must have a descriptive name.

Good:
```ts
/**
 * @example Aligning a multi-line value at its insertion column
 * ```ts
 * align('hello');
 * ```
 */
```

Bad:

````ts
/**
 * @example
 * ```ts
 * align('hello');
 * ```
 */
```

## Complex logic

When logic is non-obvious, explain it clearly in code comments or TSDoc.

This especially applies to:

* regex-heavy code
* bitwise or binary logic
* tricky branching
* parser recovery logic
* performance-sensitive code

When needed, include:

* a short explanation of intent
* the key assumptions
* a step-by-step walkthrough
* clarification of abstract codes or markers
* an ASCII diagram if it materially improves understanding

## Error handling

* The parser never throws on arbitrary input.
* Malformed input should still produce a valid result with recovery behavior.
* Prefer typed errors or discriminated union results where appropriate.
* At system boundaries, validate inputs explicitly.
* Recovery events may be emitted when that helps consumers reason about malformed input.

## Validation

Run this after public API or documentation changes:

```bash
deno doc --lint mod.ts
```

Fix all reported issues before considering the work complete.
