---
description: Benchmark quality standards for this repo
applyTo: "**/*_bench.ts,**/*bench*.ts"
---

# Benchmarking Rules

This project uses [mitata](https://github.com/nicolo-ribaudo/mitata) for
benchmarks. The rules below prevent the most common measurement errors in
JavaScript benchmarks.

## Non-negotiable: always call `do_not_optimize()`

The JIT compiler (V8) can detect that a computation's result is unused and
eliminate the entire call — measuring an empty loop instead of your code.
`do_not_optimize()` forces the result to be "consumed" without actually using
it.

**Every benchmark callback must wrap its return value:**

```ts
import { bench, do_not_optimize } from "npm:mitata";

bench("parse: simple article", () => {
  do_not_optimize(parse(simpleArticle));
});
```

Omitting `do_not_optimize()` is the single most common cause of misleadingly
fast benchmark numbers. Treat any benchmark missing it as broken.

## Prevent constant folding with computed parameters

The JIT can prove that a template string array (TSA) is always the same frozen
object and cache the entire result, hoisting it out of the loop (LICM — Loop
Invariant Code Motion). Use mitata's computed parameter syntax to generate fresh
input values outside the measured region:

```ts
bench("tokenize: varying input length", function* () {
  const input = yield {
    [0]() {
      return generateWikitext(100);
    },
  };

  bench(input, (v) => {
    do_not_optimize([...tokens(v)]);
  });
});
```

Use computed parameters for any benchmark where inputs could be constant-folded
by the JIT.

## Control GC for allocation-heavy benchmarks

String allocation benchmarks produce unpredictable p99 numbers because random GC
pauses inflate outliers. Use `.gc('inner')` to run GC before each iteration:

```ts
bench("parse: large article", () => {
  do_not_optimize(parse(largeArticle));
}).gc("inner");
```

Use `.gc('outer')` when you want GC to run once before the entire benchmark
trial rather than before every iteration (lower overhead, less stable
per-iteration measurements):

```ts
bench("events: minimal overhead check", () => {
  do_not_optimize([...events(input)]);
}).gc("outer");
```

**Rule of thumb:** any benchmark that allocates a string larger than ~10 KB per
iteration should use `.gc('inner')`.

## Use `.range()` instead of manual `.args()` for scaling tests

`.range('n', min, max)` auto-generates power-of-2 values, which is cleaner than
manually listing `.args([1, 2, 4, 8, 16, ...])`:

```ts
bench("parse: N-line article", function* (state) {
  const n = yield state.range("n", 1, 64);
  const input = generateWikitext(n * 100);

  bench(String(n), () => {
    do_not_optimize(parse(input));
  });
});
```

## Always benchmark against competitor libraries

Performance claims are meaningless without comparison. Benchmark against
`wtf_wikipedia` and `wikiparser-node` on the same input:

```ts
import wtf from "npm:wtf_wikipedia";

const article = Deno.readTextFileSync("tests/corpus/earth.wikitext");

bench("parse (ours)", () => {
  do_not_optimize(parse(article));
});
bench("wtf_wikipedia", () => {
  do_not_optimize(wtf(article));
});
```

Use identical inputs. Run them in the same benchmark group so mitata's output
puts them side-by-side.

## Benchmark realistic scenarios, not just microbenchmarks

Microbenchmarks with degenerate inputs (empty string, single heading) don't
represent real usage. Include benchmarks for each of these patterns:

- **Token-only** — `[...tokens(input)]`. Measures raw scanner throughput without
  any structure building.
- **Events-only** — `[...events(input)]`. Measures the full event pipeline
  (tokenize + block + inline) without tree allocation.
- **Full AST** — `parse(input)`. End-to-end: tokenize, events, tree build.
- **Round-trip** — `stringify(parse(input))`. Full cycle including serialization.
- **Outline-only** — `[...outlineEvents(input)]`. Block structure only, no
  inline parsing cost. Compare against full events to show the speedup.
- **Large article** — a real Wikipedia Featured Article (50K–200K chars). This
  exercises all code paths and exposes allocation pressure.
- **Pathological input** — deeply nested templates, 1000-row tables, long
  apostrophe runs. Exercises worst-case performance.

## Memory tests must be proper mitata benchmarks

Ad-hoc heap-delta tests that run outside the benchmark loop produce noisy
measurements that aren't comparable across runs. Either:

1. Convert them to mitata benchmarks with `.gc('inner')` so GC is controlled, or
2. Move them to a clearly separate test file and treat them as regression
   assertions (not performance measurements).

Don't mix manual `performance.memory` checks inside mitata benchmark callbacks.

## Anti-patterns

- **Discarding return values** — always `do_not_optimize()` the result.
- **Same literal in every iteration** — use computed parameters to prevent LICM.
- **Benchmarking only the happy path** — include at least one pathological input
  (e.g., deeply nested indentation, very long lines) alongside common inputs.
- **No competitor baseline** — if you can't show the parser is faster than
  wtf_wikipedia or wikiparser-node on a given operation, don't claim it is.

## Live-editing benchmark suites (Phase 6–7)

These benchmarks measure interactive and streaming performance — not batch
parsing. Implement them when the Session API lands.

### Keystroke loop (Phase 7)

Simulates a user typing in the middle of a document. Measures amortized cost
of single-character inserts followed by incremental reparse.

```ts
bench("keystroke: insert char mid-document", () => {
  const session = createSession(largeArticle);
  session.parse(); // warm caches
  for (let i = 0; i < 200; i++) {
    session.applyChanges([
      { offset: cursorPos, deleteCount: 0, insertText: "x" },
    ]);
    do_not_optimize(session.parse());
  }
});
```

Target: < 5 ms per keystroke on a 100K-char article. Each iteration must
include the full reparse — don't measure only `applyChanges`.

### Append-only stream (Phase 6)

Simulates LLM token streaming or progressive network load. Measures
`session.write()` + `drainStableEvents()` throughput.

```ts
bench("stream: append 1K chunks", () => {
  const session = createSession("");
  for (const chunk of chunks1K) {
    session.write(chunk);
    do_not_optimize([...session.drainStableEvents()]);
  }
});
```

Target: O(1) amortized per drain (stable prefix grows monotonically).
The stability frontier should advance without re-scanning the entire input.

### Remote merge burst (Phase 7)

Simulates a batch of remote edits arriving at once (collaboration scenario).
Measures edit coalescing effectiveness.

```ts
bench("merge: 50 remote edits in burst", () => {
  const session = createSession(largeArticle);
  session.parse();
  session.applyChanges(fiftyScatteredEdits);
  do_not_optimize(session.parse());
});
```

Compare against 50 individual `applyChanges` calls to show coalescing wins.
Use `.gc('inner')` — these allocate heavily.
