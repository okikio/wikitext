# Pipeline

This parser is easiest to understand as one pipeline with a few different exit
points.

```text
TextSource
  -> tokenize()
  -> blockEvents()
  -> inlineEvents()
  -> tree or other consumers
```

Each stage does less than many readers expect.

One important grounding detail runs through the whole pipeline:

the parser is not primarily passing copied strings from stage to stage.
It is primarily passing text ranges into the original source.

That difference matters because this repo is trying to preserve three things at
once:

- source fidelity
- predictable offsets
- low allocation cost on hot paths

If each stage kept slicing out fresh strings such as `Heading`, `[[Main Page]]`,
or `note`, the parser would keep allocating new values just to hand the next
stage text it already has. That gets more expensive on large pages, and it also
makes it easier for later stages to drift away from the exact original source.

Range-first handling avoids that. Instead of copying text eagerly, the parser
can say:

```text
the interesting content is from offset 120 to offset 164
```

Later consumers can still do the exact same practical work:

- compare delimiters
- inspect the leading or trailing characters
- re-scan for inline syntax
- materialize a string only when a caller actually needs it

That is why the repo talks about text ranges so often. They are not a lesser
form of string handling. They are the cheaper, more source-faithful base that
strings can still be derived from later.

## Stage 1: tokenizer

The tokenizer only recognizes raw text shapes.

Examples:

- `[[`
- `{{`
- `==`
- `{|`
- `<`

It does not decide the final meaning of those shapes yet. It only records where
they appear in the source.

That matters for performance and source fidelity because tokens carry offsets
into the original input instead of copied value strings.

For example, the tokenizer does not need to create a new string for every `==`
heading marker or every chunk of prose between markers. It can keep the source
once and record:

```text
HEADING_MARKER  start: 0  end: 2
TEXT            start: 3  end: 10
```

That is enough information for later stages to recover the same text exactly
when they need it.

## Stage 2: block parser

The block parser decides the large-scale document structure.

Examples:

- heading
- paragraph
- list
- table
- preformatted block

At this stage, inline content still mostly travels as text ranges. The block
parser answers questions like "is this line the start of a list item?" long
before it cares whether a later inline span contains a link or template.

That means a paragraph event can point at one contiguous source range instead of
building a new paragraph string just so the inline parser can immediately scan
it again.

Example:

```text
source: "A paragraph with [[Main Page]] and {{Template}}."

block stage result:
  paragraph text range = source[0..48]
```

The block parser does not need to eagerly split that prose into new strings for
`A paragraph with `, `[[Main Page]]`, and ` and {{Template}}.`. It can hand the
inline parser one accurate range and let the inline parser do the finer scan.

## Stage 3: inline parser

The inline parser revisits text ranges and looks for smaller constructs inside
them.

Examples:

- emphasis
- wikilinks
- templates
- parser functions
- ref-like tags

This is where commitment points matter most. A tag-like opener is not treated
as structurally real just because the parser saw `<ref`. It becomes real once
the opener reaches its closing `>`.

The inline parser still does not lose anything by starting from ranges instead
of copied strings.

If it receives a text event covering offsets `20..48`, it can still:

- look at `source.charCodeAt(20)`
- scan forward for `[[`, `{{`, or `<ref`
- slice out the exact text later if a consumer wants it
- attach child ranges for the link label, template name, or tag body

In other words, ranges can accomplish the same parsing work as eager strings,
while delaying allocation until there is a real reason to materialize text.

## Stage 4: consumers

Once the event stream exists, different APIs can consume it in different ways.

```text
event stream
  -> outlineEvents()  cheap block-only structure
  -> events()         full event stream
  -> buildTree()      AST materialization
  -> filter()         focused tree queries
  -> future renderers and session-aware tools
```

This is why the repo is event-stream-first. The tree is important, but it is
not the only useful output.

It is also why text events are range-first. A downstream consumer can still ask
for strings, but the parser does not force every consumer to pay for those
strings up front.

## Why this split exists

The split is not just academic layering.

It buys three concrete things:

- cheaper partial use, because some callers only need tokens or block structure
- clearer contracts, because block and inline decisions do not silently blur
  together
- better future support for streaming, sessions, and editor overlays

If a future change makes this split harder to reason about or slower in
practice, that change should be challenged. The split only earns its keep if it
preserves correctness and reduces repeated work.