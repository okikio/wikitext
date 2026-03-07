# Agent Memory

This directory stores file-based state for agent work so progress survives
context resets. Durable notes that teammates can rely on live in the top-level
files and the `ACTIVE`, `DECISIONS`, and `CHECKLISTS` folders. Scratch notes
live under `SESSIONS` and are gitignored.

## Constraints

- Do not store secrets, tokens, private URLs, or customer data.
- Keep `ACTIVE` short and current; archive completed work.
- Prefer small, verifiable tasks that can be completed in one iteration.

## Approach

Use `ACTIVE` as the control panel for ongoing work, `DECISIONS` for long-lived
architectural choices, and `CHECKLISTS` for repeatable quality gates.

Keep current parser milestones and the larger platform vision separate. The
parser remains the active proving ground; broader future direction belongs in
`PROJECT`, `DECISIONS`, and tightly scoped notes in `ACTIVE`, not in inflated
task lists.

## Edge cases

If `TASKS` grows too large, split into multiple files or an epic folder. If a
decision affects the public API or documented behavior, promote it to an ADR.
