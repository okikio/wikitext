# Sessions and Streaming

The stateless parser functions are the core API.

The session API exists for the cases where a caller wants to ask more than one
question about the same source, or where the source changes over time.

## What a session is

A session is a cached wrapper around the same parser pipeline.

```text
createSession(source)
  -> cached outline events
  -> cached full events
  -> cached tree materializations
  -> later streaming and incremental edit support
```

It is not a different parser.

It is still the same range-first parser. The session mainly caches views over
the same source and, later, over changes to that source.

## What sessions buy you

Without a session, each call starts again from the original source.

With a session, one caller can ask:

- `outline()`
- `events()`
- `parse()`
- `parseWithDiagnostics()`
- `parseStrictWithDiagnostics()`

and reuse earlier work where that reuse is valid.

That matters most for editors, live previews, and repeated structural queries.

That reuse works because the underlying outputs stay anchored to the same
source ranges and UTF-16 offsets. If the parser eagerly rewrote text into new
strings at every step, much less of that work would compose cleanly.

## Cache lanes follow the same cost model

The session should not force every caller onto the expensive diagnostics path.

That is why its caches follow the same split as the stateless APIs:

```text
diagnostics off
  -> cheapest event and tree access

diagnostics on
  -> diagnostics-preserving event and tree access
```

If a caller only wants the cheap lane, the session should not allocate or keep
diagnostics-enabled state unless some other call already paid for it.

The same rule applies to text materialization. Sessions should prefer caching
range-first parser products over eagerly caching many duplicate string views of
the same source.

## Streaming and the stability frontier

Streaming input creates one extra problem: the parser needs to distinguish what
is already stable from what may still change.

```text
stable prefix | provisional tail
```

The boundary between them is the stability frontier.

Before the frontier, events are safe to treat as committed.
After the frontier, later source may still close an open construct and change
the parse.

That is the core idea behind future streaming support such as:

- `session.write(chunk)`
- stable-event draining
- provisional-tail replacement

## Incremental editing

Incremental parsing is the later session feature for edited text, not just
append-only streaming.

The parser direction here is:

- find the smallest safe region to reparse
- reuse the rest of the prior work
- return a `PositionMap` so cursors, selections, and comment-like anchors can
  be translated across edits

That only works if positions and source spans stay authoritative enough to map
old work onto new source confidently.

That is how the parser supports editor-like workflows without turning the core
pipeline into an editor framework.

## Why this belongs outside the main architecture overview

Sessions, streaming, and incremental reparsing are important, but they are not
the first thing most readers need.

Most people first need to know:

- what the parser outputs are
- which tree lane to choose
- how the pipeline roughly works

This note exists so those live-use-case details stop crowding the main
architecture entry point.