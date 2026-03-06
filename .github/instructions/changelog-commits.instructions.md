---
description: Commit message and changelog standards for this repo
applyTo: "**"
---

# Commit messages and changelog writing

Apply these rules only when writing or revising:
- commit messages
- changelog entries
- release notes
- version summary text

Do not apply these rules to normal code comments, TSDoc, docs, PR prose, or issue descriptions unless the task is specifically about commits or changelogs.

A commit message is not just a label for Git history. It is a durable record that other developers will scan later to understand what changed, why it changed, and what belongs in the changelog.

Write commits so a reader can understand the important change without opening the diff first.


## Main goal

Each commit message should make these things easy to answer:

1. What changed?
2. Why did it matter?
3. What behavior, edge case, or workflow changed?
4. Is there upgrade or migration impact?
5. If this later becomes a changelog entry, what should be carried forward?

If the subject is precise but the body is vague, the message is incomplete.
If the body is detailed but the subject hides the actual outcome, the message is incomplete.


## Commit subject format

Use Conventional Commits.

Use this subject shape:

`type(scope?): short precise outcome summary`

Replace `type`, `scope`, and the summary with real values.
Do not output placeholder text literally.

Examples:

- `fix(parser): preserve trailing blank lines in stringify`
- `fix(tokenizer): stop merging adjacent pipe delimiters across template boundaries`
- `feat(events): emit outline-only section events`
- `docs(instructions): clarify commit body rules for changelog-ready history`

Do not write:

- `<type>(<scope>): <description>`
- `fix: improve parser`
- `chore: update stuff`
- `refactor: cleanup`
- `docs: change instructions`


## Subject rules

The subject is the scan line. A developer should be able to skim 30 commits and quickly understand the story of the codebase.

Rules:
- Type is lowercase.
- Use a single space after the colon.
- Do not end the subject with a period.
- Keep the subject specific and outcome-focused.
- Describe an observable result, not a coding activity.
- Name the actual behavior, workflow, edge case, or contract that changed.
- Prefer the most important result when the commit contains several changes.
- Avoid filler verbs such as `improve`, `update`, `enhance`, `clean up`, `address`, or `adjust` unless the object makes the change concrete.

Good:
- `fix(ast): keep heading end offsets aligned after recovery`
- `feat(cli): add --json output for extraction summary`
- `docs(parser): explain why the tokenizer never throws`

Bad:
- `fix: improve heading parsing`
- `feat: add new stuff`
- `refactor: clean up parser logic`
- `docs: update readme`


## How to choose the subject when a commit has multiple changes

A commit often includes one primary change and several supporting changes.

The subject should name the highest-value outcome.
The body should name the important supporting changes.

Example:

Bad:
- `fix(parser): handle headings, tables, and links better`

Better:
- `fix(parser): recover table parsing after unmatched row delimiter`

Body:
- preserves heading parsing after malformed tables
- stops recovery from swallowing following link tokens
- adds regression coverage for mixed table and heading input

Do not cram a shopping list into the subject.
Use the subject for the main story and the body for the supporting facts.


## Commit body rules

Add a body when any of these are true:
- the commit changes behavior in a non-obvious way
- the commit fixes more than one important case
- the commit has migration or upgrade impact
- the commit includes trade-offs, constraints, or compatibility notes
- the subject alone would not be enough for a changelog writer

A good body explains:
- what was wrong before
- what is true now
- the most important cases covered
- any notable limitation, migration step, or compatibility note

Prefer short bullets or short paragraphs.
Keep the body concrete.
Name real behavior, not vague intent.

Good body:

- preserve trailing blank lines when stringify receives CRLF input
- stop recovery from dropping text after malformed table rows
- keep token offsets stable so downstream range-based consumers still reconstruct the original source

Weak body:

- improve parser behavior
- refactor logic
- add tests
- various fixes


## Recommended body shape

When a body is needed, prefer this order:

1. Problem or previous bad behavior
2. New behavior or outcome
3. Important secondary changes or edge cases
4. Migration or upgrade impact if relevant

Example:

`fix(stringify): preserve trailing blank lines in CRLF input`

- previously the final blank line could disappear when the source ended in `\r\n`
- stringify now preserves the original trailing blank line count
- keeps output stable for roundtrip tests and source-fidelity consumers

That shape makes the history readable and easy to turn into release notes.


## What “precise” means in this repo

A precise commit message names the actual thing that changed.

Prefer:
- the visible behavior
- the broken case
- the API contract
- the recovery rule
- the migration impact
- the downstream effect for callers or maintainers

Avoid subjects and bodies that only describe implementation activity.

Prefer:
- `fix(scanner): treat !! as a behavior switch opener only at line start`

Over:
- `fix(scanner): tweak behavior switch handling`

Prefer:
- `refactor(events): split section balancing from text emission`

Over:
- `refactor(events): reorganize parser internals`

The second example can be acceptable only when the commit is truly internal and there is no user-visible behavior change. Even then, the message should still explain the architectural result.


## Types and how to use them

Use the smallest truthful type.

- `feat`: new user-visible capability
- `fix`: bug fix or behavior correction
- `refactor`: internal restructuring without intended behavior change
- `docs`: documentation or instruction changes
- `test`: test-only changes
- `build`: build, packaging, or dependency behavior
- `ci`: CI pipeline changes
- `perf`: measurable performance improvement
- `chore`: repository maintenance with no better type

Do not hide real fixes under `chore`.
Do not use `refactor` when behavior changed.
Do not use `docs` when the commit also changes runtime behavior.


## Scopes

Use a scope when it helps a reader locate the area of change quickly.

Good scopes:
- `parser`
- `tokenizer`
- `events`
- `ast`
- `stringify`
- `cli`
- `instructions`

Skip the scope if it adds no value.

Bad scopes:
- `stuff`
- `misc`
- `repo`
- `general`

The scope should narrow meaning, not add noise.


## Breaking changes

Mark breaking changes with `!` and explain the migration impact in the body or footer.

Example:

```text
feat(api)!: remove implicit trim from align()

BREAKING CHANGE: Callers that relied on implicit trimming must call trimEnd() explicitly before align().