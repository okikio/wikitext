# Review Checklist

## Correctness

- [ ] Behavior matches the stated intent.
- [ ] Edge cases handled explicitly (empty input, single line, all whitespace,
      mixed line endings, unclosed tags, nested templates, apostrophe runs,
      malformed tables, mixed list markers).
- [ ] Never-throw invariant preserved — parser produces valid output for all input.

## Safety

- [ ] No unsafe patterns (eval, silent fallbacks, implicit coercions).
- [ ] Trust boundaries are clear.
- [ ] Event well-formedness: every `enter` has matching `exit`, proper nesting.

## Maintainability

- [ ] Naming is clear, intent-revealing, and consistent with the existing API.
- [ ] Complex logic is explained with comments or ASCII diagrams.
- [ ] `deno doc --lint mod.ts` still passes — no `private-type-ref` errors.

## Performance

- [ ] Hot paths use `charCodeAt`, not `charAt` or string comparisons.
- [ ] Tokens are offset-based (no unnecessary string allocation).
- [ ] No closures or megamorphic call sites in inner loops.

## Verification

- [ ] `deno task test` passes.
- [ ] `deno doc --lint mod.ts` passes.
- [ ] Verification steps are adequate for the stated change.
