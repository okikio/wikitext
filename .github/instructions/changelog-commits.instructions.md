---
description: Commit message and changelog standards for this repo
applyTo: "**"
---

# Commits and Changelogs

Apply these rules only when writing or revising:
- commit messages
- changelog entries
- release notes
- version summary text

Do not apply these rules to normal code comments, TSDoc, docs, or PR prose unless
the task is specifically about commits or changelogs.


## Commit subject format

Use Conventional Commits:

```text
<type>(<scope>): <description>
```

Examples:

* `fix: prevent double-stripping on nested undent calls`
* `feat(parser): add outline-only event stream`

## Subject rules

* Type is lowercase.
* Use a single space after the colon.
* Do not end the subject with a period.
* Keep the subject specific and outcome-focused.
* The subject should describe an observable change, not a vague activity.
* Avoid filler verbs such as `improve`, `update`, `enhance`, `clean up`, or `address` unless the object makes the change concrete.

Good:

* `fix: preserve trailing blank line e.g. \r in stringify`
* `docs: add header quality rules for TSDoc sections`

Bad:

* `fix: improve parser`
* `docs: update instructions`
* `refactor: clean up code`

## Breaking changes

Mark breaking changes with `!` and explain the migration impact in the footer or body.

Example:

```text
feat(api)!: remove implicit trim from align()

BREAKING CHANGE: Callers that relied on the implicit trimming must call trimEnd() explicitly.
```

## Changelog writing

The changelog is a communication artifact for users.

When writing a changelog entry:
* lead with the user-visible behavior change
* mention upgrade impact when relevant
* mention migration steps for breaking changes
* prefer concrete outcomes over implementation detail

Call out breaking entries with `**Breaking:**` when needed.

Write for user impact, not internal implementation detail.

Good:

* `Fix stringify dropping content after malformed table recovery`

Weak:

* `Refactor malformed table handling`

## Anti-patterns

* typeless commits
* WIP commits on main
* vague subjects
* issue or PR numbers in the subject
* subjects that only describe intent instead of result
* internal implementation detail with no user-facing meaning