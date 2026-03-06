---
description: Markdown and long-form documentation writing style for this repo
applyTo: "**/*.md"
---

# Documentation Writing

## Core priority

Lead with user benefit before internal mechanics.

When introducing a concept, prefer this narrative order:

1. What it is
2. What problem it solves
3. What the reader gets from it
4. How it works at a high level
5. Examples, assumptions, edge cases, limitations, and deeper detail

Use this as a default shape, not a rigid template.

## Writing style

- Use plain English.
- Define technical terms the first time they matter.
- Keep a steady narrative flow.
- Prefer transition sentences over unnecessary headers.
- Use active voice.
- Use present tense where practical.
- Use the subject's real name instead of vague passive phrasing.
- Expand acronyms on first use.
- Avoid em dashes.

## Header rules

Add a header only when it improves navigation more than a transition sentence would.

A useful header must do all of these:
- mark a real subject shift
- be specific about what follows
- add information on its own
- still make sense in a document outline

Prefer headers that name:
- the concept being defined
- the decision being justified
- the API or behavior being introduced
- the failure mode or edge case being explained
- the outcome being unlocked

Good:
- `Why the parser never throws`
- `Type guards, builders, and structural unions`
- `Event well-formedness and stack discipline`
- `How range-first text events avoid extra allocation`

Weak:
- `Overview`
- `Usage`
- `Details`
- `How it works`
- `How to use this`

If the next paragraph continues the same idea, do not add a header.

## Examples and visual aids

Use examples when they materially improve understanding.

Use ASCII diagrams when they clarify:
- structure
- flow
- hierarchy
- state transitions
- algorithm steps

Do not add diagrams just to decorate the prose.

Always explain what the reader is looking at before or after the diagram.

## Specs and design notes

For specs, proposals, and design notes, prefer RFC-style structure:

- Problem
- Goals
- Non-goals
- Constraints
- Proposal
- Alternatives
- Risks
- Rollout
- Open questions

Keep decisions concrete. Make trade-offs explicit. State assumptions plainly.

## Anti-patterns

- Do not bury the lede under prerequisites or implementation detail.
- Do not list features before explaining the problem they solve.
- Do not create many tiny headers that simply label the next paragraph.
- Do not hedge with soft filler language when the point can be stated directly.
- Do not explain implementation details before the reader understands why they matter.