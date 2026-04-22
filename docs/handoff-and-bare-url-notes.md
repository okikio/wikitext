# Block/Inline Handoff and Bare-URL Notes

This note records two narrow follow-ups from the diagnostics-first redesign:

1. how to tell whether the block-to-inline split is helping or hurting
2. which bare-URL rules belong in the core parser instead of downstream tools

The goal is to keep the work measurable and local. Neither topic needs a broad
parser rewrite to become clearer.

## What this note is for

The parser already has a strong default shape:

```text
TextSource -> tokenizer -> blockEvents() -> inlineEvents() -> tree consumers
```

That shape is worth keeping as long as the handoff preserves structure and
reduces repeated work. The right next step is not "merge the stages because two
stages feel suspicious." The right step is to measure the handoff directly and
to tighten the ambiguity rules that still look too ad hoc.

Bare URLs are the clearest current example of that second category.

## How to evaluate the block-to-inline handoff

There are two separate questions.

First, does the handoff preserve the parser contracts?

- `outlineEvents()` and `events()` must agree on block structure.
- `parse()` must preserve that same block structure in the default lane.
- contiguous prose ranges must not lose spaces, punctuation, or boundaries
  just because they were merged before inline parsing.

Second, does the handoff actually save work?

The useful benchmark comparison is:

```text
fragmented handoff
  many neighboring text events
  -> inline parser merges them before scanning

merged handoff
  one larger contiguous text event
  -> inline parser scans once
```

If merged handoff is not faster, or if it causes structural drift, then the
boundary needs work. If it is faster and keeps the contracts intact, then the
split is doing its job.

That is why the benchmark work here isolates merged versus fragmented text
groups for the same input instead of comparing unrelated documents.

## What belongs in the core bare-URL matcher

The core parser does need bare-URL recognition, but it should stay narrow and
cheap.

The matcher should own only the rules needed to answer this parser question:

```text
does this source range clearly contain a link-shaped URL token here?
```

That means the core matcher should handle:

- accepted schemes in the core lane
- start boundaries, so URLs do not begin in the middle of ordinary words
- end boundaries, so trailing prose punctuation does not become part of the URL
- lightweight balancing rules for common prose wrappers such as a trailing `)`

That does not mean the core parser should do full URL normalization,
base-URL-aware resolution, or browser-style canonicalization. Those jobs belong
to downstream consumers.

## Current acceptance matrix

The current matcher keeps two different promises.

- Explicit bracketed external-link syntax is broad. If the author wrote
  `[scheme:payload Label]`, the parser should usually trust that they meant a
  link and leave scheme-policy decisions to downstream consumers.
- Bare autolinks in prose are narrower. They should catch the common cases and
  a strong set of opaque URI shapes, but they should not overmatch ordinary
  colon prose.

That gives this working matrix:

| Case | Bare prose | Bracketed explicit syntax | Reason |
| --- | --- | --- | --- |
| `https://example.com` | accept | accept | authority form is high-confidence |
| `file:///Users/example/report.txt` | accept | accept | authority form is high-confidence |
| `foo+bar://example.service/path` | accept | accept | authority form is high-confidence |
| `mailto:editor@example.org` | accept | accept | `@` is strong opaque-URI evidence |
| `urn:isbn:0451450523` | accept | accept | repeated `:` plus digits is strong opaque-URI evidence |
| `data:text/plain,hello` | accept | accept | `/` and `,` make the payload structurally URI-like |
| `tel:+12025550123` | accept | accept | leading `+` plus digits is strong opaque-URI evidence |
| `magnet:?xt=urn:btih:...` | accept | accept | `?` and `=` make the payload structurally URI-like |
| `longcustomscheme:alpha` | reject | accept | too little structure for safe bare autolinking |
| `note:abc` | reject | accept | reads like ordinary colon prose in bare text |
| `chapter:one` | reject | accept | reads like ordinary colon prose in bare text |

The general rule is simple: if a URI is not distinct enough to be recognized
confidently in bare prose, it should stay text and let an end consumer extend
that policy if they care about a niche scheme.

The stable low-level boundary rules are still:

- a bare URL must start at a word boundary, not in the middle of an ASCII word
- the scan stops before whitespace, quotes, `]`, `<`, or `>`
- trailing prose punctuation such as `.`, `,`, `;`, `:`, `!`, and `?` is
  trimmed from the URL
- a trailing `)` is trimmed only when it is unmatched within the scanned URL

That gives a practical parser rule:

```text
Visit https://example.com.
      ^^^^^^^^^^^^^^^^^^^   external-link
                         .  plain text
```

and:

```text
(https://example.com/path(test))
 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^   external-link
                              )  plain text
```

The parser keeps the balanced inner parentheses because they can be part of a
real URL path, but it leaves the extra outer prose wrapper behind.

## What still stays out of scope

The core matcher still does not try to solve every URI or IRI question.

That is intentional.

- RFC 3986 and RFC 3987 are useful references for boundary decisions.
- WHATWG URL behavior is useful for web-facing expectations.
- MediaWiki behavior still matters where it intentionally differs.

But the hot path should not instantiate `URL` objects or require a base URL
just to recognize a bare link-shaped span in plain text. That would increase
allocation cost and couple parser recognition to downstream normalization.

## What to watch next

If future work expands bare-URL support, the next useful checks are:

1. whether any rejected bare opaque cases deserve promotion into the core
  acceptance matrix or should stay consumer-owned extensions
2. whether any IRI behavior is important enough to justify extra scan cost
3. whether MediaWiki-compatible punctuation trimming needs a more exact rule
4. whether URL-heavy prose changes the value of the current block-to-inline
   merge strategy

Those are good follow-ups only if the current tests and benchmarks show a real
gap. Until then, the better strategy is to keep the core matcher small,
predictable, and benchmarked.