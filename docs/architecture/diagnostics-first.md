# Diagnostics-First Model

This note explains the diagnostics-first idea without the full redesign
discussion.

Use it when you want the architecture model, not the whole design-history note.

If you want the caller-facing tree choice first, read
[choosing-a-parser-result.md](./choosing-a-parser-result.md).

If you want the future public-surface direction, read
[api-direction.md](./api-direction.md).

## The short version

Diagnostics-first means the parser should be clearest about what it found
before it is clever about how to repair it.

That does not remove tolerant parsing. It separates three jobs that were too
easy to blur together.

## The core split

The parser does three different jobs that used to blur together in the docs.

```text
diagnostic      = factual parser finding
continuation    = minimal internal behavior that lets parsing proceed
materialization = caller-visible choice about the final tree shape
```

That split matters because `never throw` does not mean "the parser must pick
one canonical repaired tree for everyone." It means the parser keeps going and
preserves what it found.

In plain English:

- diagnostics answer "what went wrong here?"
- continuation answers "how did the parser keep going?"
- materialization answers "what final tree should the caller get?"

When a caller wants to delay that third choice, it needs an `analyze()` lane:
a replayable package of events, diagnostics, and later possible recovery data
that can feed one or more explicit materializers.

There is also one more exploratory step beyond that: a policy lane where the
caller decides some recoveries itself. That should be treated as a layer on top
of `analyze()`, not as a new parser truth.

## What callers are really choosing today

Most callers are choosing between these lanes:

```text
parse()
  -> cheap default tree

parseWithDiagnostics()
  -> default tolerant tree + diagnostics

parseStrictWithDiagnostics()
  -> conservative tree + diagnostics

parseWithRecovery()
  -> default tolerant tree + diagnostics + recovery summary
```

The key point is that `parseWithDiagnostics()` and `parseStrictWithDiagnostics()` are not two
different parser truths. They are two materializations of the same parser
findings.

That is the heart of the model. Malformed input should not force the docs into
teaching several competing parser realities.

## What diagnostics-first does not mean

It does not mean the parser stops doing continuation work internally.

The parser still has to:

- keep the event stream well-formed
- survive malformed input
- auto-close or normalize enough internal state to stay usable

The real question is whether those continuation steps become one mandatory
caller-facing tree shape or remain facts plus materialization choices.

That is why diagnostics-first is not a "strict parser" slogan. The parser can
stay forgiving and still avoid turning one repair policy into the only public
story.

## Why this matters for malformed input

Malformed input is where the distinction becomes visible.

The parser should stay explicit about structural evidence and commitment points.

```text
before commitment
  -> keep text-backed interpretation

after commitment
  -> keep the structural finding
  -> let the chosen tree policy decide how much survives in the final tree
```

That is why the same malformed input can yield:

- a tolerant structural node in the default lane
- plain text in the conservative lane
- and the same diagnostics in both

The parser finding stays the same. What changes is the caller-facing tree
policy.

## Why this matters for docs and APIs

If the docs lead with wrapper names alone, they make it sound like the parser
owns several different malformed-input truths.

The cleaner explanation is:

1. the parser finds something malformed
2. the parser keeps going
3. the caller chooses whether to ask for a tree now, or keep findings first
4. if the caller does want a tree, the caller chooses how much repair should
   show up in the final tree

That same split should shape the public API over time.

## The still-open next lane

There is one stronger diagnostics-first idea that is not fully a public lane
yet:

```text
parser findings are preserved
recovery data is exposed
final materialization is delayed or caller-owned
```

That would go beyond `parseStrictWithDiagnostics()`. `parseStrictWithDiagnostics()` still chooses a final
tree policy for the caller. A true findings lane would expose findings first
and let the caller decide later which recoveries to keep, discard, or replace.

The event stream should remain the primitive underneath that lane, but a raw
generator is probably not enough as the public shape. A caller may need to
read diagnostics, compare recoveries, and materialize multiple
different tree policies from the same parse.

The practical target is closer to this:

```text
source
  -> analyze()
    events + diagnostics + recovery data
  -> materialize(default-html-like) when wanted
  -> materialize(source-strict) when wanted
  -> materialize(custom policy) only if that later lane proves worth exposing
```

That is a real future direction, but the docs should name it as an open design
question rather than implying that the current API already provides it.

The longer reasoning, rollout questions, and open design questions stay in
[docs/diagnostics-first-redesign.md](../diagnostics-first-redesign.md).