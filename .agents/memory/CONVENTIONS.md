# Conventions

## Intent

Capture conventions that agents should follow when working in this repo.

## Context

This repo values small, verifiable changes and file-based progress that
survives context resets.

## Constraints

- Keep notes brief and actionable.
- Do not store secrets or customer data.
- Prefer explicit configuration and clear error handling.

## Approach

- Read `ACTIVE/PLAN.md` and `ACTIVE/TASKS.md` before starting multi-step work.
- Update `ACTIVE/PROGRESS.md` after meaningful progress.
- Mark tasks done only when acceptance checks pass.
- Promote architectural decisions to ADRs in `DECISIONS/`.
- Run `deno task test`, `deno task bench`, and `deno doc --lint mod.ts` before
  marking any API-touching task complete.
- The parser never throws: enforce the never-throw invariant in every change.
- Offset-based tokens only: never store value strings on tokens.

## Edge cases

If work spans multiple iterations, capture risks in `ACTIVE/RISKS.md` to avoid
context loss.

Wikitext-specific edge cases to always consider:
- Unclosed bold/italic, `[[`, `{{`: error recovery, not exceptions
- Mixed line endings (`\n`, `\r\n`, bare `\r`)
- Surrogate pairs (emoji, CJK)
- Deeply nested templates/tables
- Empty input, single newline
