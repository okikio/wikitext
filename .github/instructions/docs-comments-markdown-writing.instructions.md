---
description: Documentation, markdown, comments, and tsdocs writing style for this repo
applyTo: "**/*.md,**/*.ts,**/*.tsx"
---

# Documentation Writing Style (should also apply to TSDocs and comments)

## Narrative structure

Lead with user benefit, not internal mechanics:

1. **What is it?** One plain-English sentence about what the thing is.
2. **What does it do?** What problem it solves and what happens when you use
   it.
3. **What do you get?** The concrete benefit: cleaner output, less code, fewer
   bugs, etc.
4. **How does it work?** The high-level approach, key techniques, and broader
   intent/reasoning behind the system.
5. **Grounding example & details.** Metaphors, charts, diagrams, tables, lists,
   blockquotes, code examples, assumptions, edge cases, limitations, and other
   important context.

This order applies to READMEs, descriptions, prs, TSDocs, comments,
and any prose that introduces a concept.

## Writing style

- Write with a clear narrative and smooth transitions. Aim for steady pacing
  and momentum. When the prose flows naturally from one topic to the next, use
  transitions instead of headers: a bridging sentence is less disruptive than
  a heading that resets the reader's rhythm.
- Place headers only where there are distinctly separate concepts and the
  pacing benefits from the break. A header that labels the next paragraph is
  noise; one that signals a genuine subject shift helps the reader reorient.
  When a header is warranted, make it descriptive and functional, not just
  topical.
- Headers should be action-oriented and benefit-driven. Avoid vague labels like “Overview” or “How to use”; instead, describe the specific task, outcome, or concept shift (e.g., “Building nodes programmatically,” “Walking the tree to collect text”).
- Use plain English. When technical terms are necessary, define them clearly and
  ground them in context.
- Use the subject's name naturally rather than passive constructions.
- Expand acronyms on first use and define key terms.
- Include ASCII diagrams when they clarify structure or sequence.
- When describing algorithms, include step-by-step "how it works" and list
  assumptions explicitly.

If writing specs or design notes:

- Prefer RFC-style structure (Problem, Goals/Non-goals, Proposal, Alternatives,
  Risks, Rollout, Open Questions).

## Grammar

- Use present tense verbs (is, opens) instead of past tense (was, opened).
- Use active voice where the subject performs the action.
- Avoid em-dash as sentence-ending rhythm ("— use X" constructs). Restructure
  the sentence or use a colon instead or some other alternative.

## Anti-patterns

- **Burying the lede**: don't open with implementation details, prerequisites,
  or caveats. Lead with what it does and why it matters.
- **Feature-first descriptions**: listing capabilities before explaining the
  problem they solve forces the reader to infer the benefit themselves.
- **Header-heavy writing**: splitting flowing prose into many small headed
  sections breaks momentum. If the reader would naturally continue from one
  topic to the next, a transition sentence serves better than a heading.
- **Over-hedging**: avoid "this may be useful if" or "you might want to
  consider". Be direct.
