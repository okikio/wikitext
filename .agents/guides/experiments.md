Make sure you understand the codebase first including the architecture, docs, and instructions.

Our goal is to benchmark various approaches to representing wikitext events to see if we can improve perf. & memory through various approaches. We're looking for statistically significant results, and not just a little bit but a notable improvement, so being better 51% of the time is not enough, assume changes have to really improve things more than just 51%.

<background>

# Wikitext event shape performance design note

## Purpose

This note captures the event-shape and data-oriented design options discussed for `@okikio/wikitext`.

The goal is not to pick an optimization because it sounds clever. The goal is to design a controlled experiment that tells us whether changing event construction actually improves the parser in a way that is large enough, stable enough, and maintainable enough to keep.

The current repo already has a strong performance contract:

```text
Remove repeated work without changing the source ranges the parser reports.
```

That contract should remain the center of the work. Any event-shape change must preserve source fidelity, parser recovery behavior, public API expectations, and the range-first model.

## Current baseline

The current public event model has five event variants:

```text
enter  -> a node starts
exit   -> a node ends
text   -> source-backed literal text range
token  -> raw tokenizer token surfaced in the event stream
error  -> recovery information
```

The important baseline traits are:

```text
Events are public plain objects.
Events carry eager `position` objects.
Text and token events carry source offsets.
Enter events carry `props`.
Tree building consumes public event objects.
Session and analyze paths can cache arrays of public events.
```

The current constructors are simple and predictable:

```ts
export function textEvent(
	start_offset: number,
	end_offset: number,
	position: Position,
): TextEvent {
	return { kind: "text", start_offset, end_offset, position };
}
```

That simplicity matters. It gives V8 a predictable object shape, keeps public behavior easy to understand, and keeps the API close to JSON-style records.

The cost is that every event pays for the full public shape immediately, including nested positions:

```text
position
  start
    line
    column
    offset
  end
    line
    column
    offset
```

The repo's own performance model already identifies eager positions as a meaningful cost to isolate. It does not prove positions are the dominant bottleneck, but it does make position construction the best first hypothesis.

## Design principle: facts first, views only when earned

The parser already behaves like a data-oriented pipeline:

```text
source text
  -> token ranges
  -> block event ranges
  -> inline event ranges
  -> optional materialized tree
```

The question is how far to take that model for events.

There are two broad paths:

```text
Path A: public events remain the only event representation
  make selected public fields lazy
  keep the event API familiar
  reduce eager allocation where possible

Path B: add a separate internal event representation
  parser works with compact internal facts
  public events become a materialized view
  larger architectural change
```

The conversation moved toward Path A first because it is smaller, easier to test, and keeps the current public event model intact.

## Approach 1: Keep the current eager public event shape

### Shape

```ts
export function enterEvent(
	node_type: string,
	props: Readonly<Record<string, unknown>>,
	position: Position,
): EnterEvent {
	return { kind: "enter", node_type, props, position };
}
```

### Reasoning

This is the baseline and should remain the default unless another approach wins clearly.

It has important benefits:

```text
Simple object creation.
Plain public objects.
No getter surprises.
No descriptor transitions.
No hidden backing state.
Easy JSON/stringify/spread behavior.
Easy debugging.
```

### Risks

```text
Every event pays for position allocation even if a consumer only reads offsets.
Nested Point and Position objects can create allocation pressure.
Small props objects may be repeatedly allocated.
Session and analyze caches can retain full public event arrays.
```

### Keep this if

```text
Lazy variants do not show a statistically significant improvement.
Lazy variants improve one path but regress parse or diagnostics meaningfully.
The implementation becomes harder to reason about without a clear win.
```

## Approach 2: Shared empty props and interned tiny props

### Shape

```ts
const EMPTY_PROPS: Readonly<Record<string, never>> = Object.freeze({});

const HEADING_PROPS = Object.freeze([
	undefined,
	Object.freeze({ level: 1 as const }),
	Object.freeze({ level: 2 as const }),
	Object.freeze({ level: 3 as const }),
	Object.freeze({ level: 4 as const }),
	Object.freeze({ level: 5 as const }),
	Object.freeze({ level: 6 as const }),
] as const);

function headingProps(level: 1 | 2 | 3 | 4 | 5 | 6) {
	return HEADING_PROPS[level]!;
}
```

### Reasoning

Some `props` values are tiny and repeated:

```text
{}
{ level: 2 }
{ ordered: false }
{ tildes: 4 }
```

Allocating a new object for every empty or tiny props payload may not be worth it. Sharing stable immutable props can reduce allocation without changing how event objects behave.

This is the lowest-risk optimization because `props` remains an eager data property.

### Risks

```text
Shared objects must be treated as immutable.
Tests should catch accidental mutation expectations.
The memory win may be small.
```

### Best use cases

```text
No-prop nodes.
Heading levels.
Ordered/unordered list wrappers.
Signature tildes.
Other small finite props sets.
```

### Decision rule

Keep this if it is behavior-neutral and shows a measurable allocation or memory improvement. Revert if it complicates code and the benchmark result is noise.

## Approach 3: Own lazy memoized `position`

### Shape

Keep public event objects as the only event representation, but define `position` lazily.

```ts
export interface PositionContext {
	readonly line_starts: readonly number[];
}

export function defineLazyPosition<T extends object>(
	event: T,
	create_position: () => Position,
): T & { readonly position: Position } {
	Object.defineProperty(event, "position", {
		enumerable: true,
		configurable: true,

		get() {
			const position = create_position();

			Object.defineProperty(event, "position", {
				enumerable: true,
				configurable: false,
				value: position,
			});

			return position;
		},
	});

	return event as T & { readonly position: Position };
}
```

Example usage:

```ts
export function textEvent(
	start_offset: number,
	end_offset: number,
	create_position: () => Position,
): TextEvent {
	const event = {
		kind: "text" as const,
		start_offset,
		end_offset,
	};

	return defineLazyPosition(event, create_position);
}
```

### Reasoning

This targets the most obvious eager cost: nested position creation.

If a consumer only reads `kind`, `start_offset`, and `end_offset`, it should not pay for line/column objects.

The memoizing getter gives three useful behaviors:

```text
If nobody reads `position`, no Position object is allocated.
If somebody reads `position` once, it is created once.
If somebody reads `position` repeatedly, later reads become normal property reads.
```

### Risks

```text
The first `position` read changes the object from accessor property to data property.
That creates a shape transition for events whose position is read.
The getter may close over local variables, which can add closure allocation.
If tree building reads every position anyway, the cost may simply move later.
Object spread or JSON.stringify may invoke the getter and materialize position.
```

### Where it should win

```text
Event consumers that only need offsets.
Filtering and analysis that reads `kind` and ranges only.
Public event iteration without tree materialization.
Potentially session event iteration where positions are rarely read.
```

### Where it may not win

```text
parse(), if tree building reads every event position.
parseWithDiagnostics(), if diagnostics force position access.
Consumers that immediately serialize full events.
Consumers that read `position` on every event.
```

## Approach 4: Lazy memoized `position` plus shared/interned eager props

### Shape

```text
position:
  lazy and memoized

props:
  eager data property
  but shared/interned where common
```

Example:

```ts
export function enterEvent(
	node_type: string,
	props: Readonly<Record<string, unknown>>,
	create_position: () => Position,
): EnterEvent {
	const event = {
		kind: "enter" as const,
		node_type,
		props,
	};

	return defineLazyPosition(event, create_position);
}
```

### Reasoning

This is the best first candidate.

It attacks the eager position cost while keeping `props` simple. It also avoids the closure-heavy trap of making every props object lazy before we know props are a real cost.

### Risks

```text
Still has lazy getter complexity for position.
Still has eager props allocation for source-sliced props.
May not help tree-building paths if positions are always read.
```

### Why this is probably the first serious experiment

It is focused. It answers one real question:

```text
Does delaying Position allocation help common event consumers enough to justify lazy getters?
```

If this does not win clearly, more complex lazy-props designs probably do not deserve attention yet.

## Approach 5: Lazy source-sliced props

### Shape

Only some props become lazy, especially props that require slicing or parsing source text.

```ts
function defineLazyProps<T extends object>(
	event: T,
	create_props: () => Readonly<Record<string, unknown>>,
): T & { readonly props: Readonly<Record<string, unknown>> } {
	Object.defineProperty(event, "props", {
		enumerable: true,
		configurable: true,

		get() {
			const props = create_props();

			Object.defineProperty(event, "props", {
				enumerable: true,
				configurable: false,
				value: props,
			});

			return props;
		},
	});

	return event as T & { readonly props: Readonly<Record<string, unknown>> };
}
```

Example:

```ts
export function wikilinkEnterEvent(
	source: TextSource,
	target_start: number,
	target_end: number,
	create_position: () => Position,
): EnterEvent {
	const event = {
		kind: "enter" as const,
		node_type: "wikilink",
	};

	defineLazyProps(event, function createProps() {
		return {
			target: source.slice(target_start, target_end),
		};
	});

	return defineLazyPosition(event, create_position);
}
```

### Reasoning

Some props are cheap:

```text
{ level: 2 }
{ ordered: false }
```

Some props are expensive because they require slicing or parsing:

```text
{ target: source.slice(...) }
{ name: source.slice(...) }
{ value: source.slice(...) }
{ url: source.slice(...) }
{ attributes: parseAttributes(...) }
```

Lazy props should focus on the second category.

### Risks

```text
A lazy props getter per event can create closure pressure.
Mixing eager `props` and accessor `props` for the same event kind can split object shapes.
Repeated access must be memoized or it creates repeated strings/objects.
Some consumers expect `props` to be a plain data property.
```

### Shape consistency rule

Do not mix this inside the same event kind:

```ts
// Avoid this mix inside one variant.
{ kind: "enter", node_type, props, position }
{ kind: "enter", node_type, get props() { return props; }, position }
```

If `EnterEvent.props` is lazy in a variant, it should be lazy for all enter events in that variant. If it is eager, it should be eager for all enter events in that variant.

### When to test this

Only after measuring that props allocation or string slicing is meaningful.

## Approach 6: Prototype or class-backed public event objects

### Shape

Instead of object-literal getters, use shared prototype getters.

```ts
class TextEventObject {
	readonly kind = "text" as const;
	readonly start_offset: number;
	readonly end_offset: number;

	#position?: Position;
	readonly #create_position: () => Position;

	constructor(
		start_offset: number,
		end_offset: number,
		create_position: () => Position,
	) {
		this.start_offset = start_offset;
		this.end_offset = end_offset;
		this.#create_position = create_position;
	}

	get position(): Position {
		this.#position ??= this.#create_position();
		return this.#position;
	}
}
```

### Reasoning

Object-literal getters can create getter functions and closure environments per event. Prototype getters share the getter implementation across instances.

This can be cleaner from a VM-shape perspective:

```text
same class
same constructor
same own fields
shared getter functions
private backing state
```

### Risks

```text
Events stop feeling like simple plain records.
Prototype getters are inherited, not own properties.
Object.keys() and JSON.stringify() behavior can differ.
Some user code may rely on spreading events.
This is a bigger public-behavior risk than own lazy getters.
```

### When to test this

Only if own lazy getters show promise but appear to allocate too much or behave inconsistently.

This is not the first candidate because public event compatibility matters.

## Approach 7: Separate internal event shape or event tape

### Shape

This was the larger data-oriented idea discussed earlier.

```ts
export interface InternalEventRecord {
	readonly kind: "enter" | "exit" | "text" | "token" | "error";
	readonly type: string;
	readonly start_offset: number;
	readonly end_offset: number;
	readonly props_ref: number;
}
```

Or a packed replay tape:

```ts
export interface InternalEventTape {
	readonly kind_ids: Uint8Array;
	readonly type_ids: Uint16Array;
	readonly start_offsets: Uint32Array;
	readonly end_offsets: Uint32Array;
	readonly props_ids: Int32Array;
	readonly count: number;
}
```

### Reasoning

The parser could work with compact facts internally, then materialize public `WikitextEvent` objects only at the boundary.

This is strongest for replayable paths:

```text
Session caches.
analyze() findings.
Repeated materialization.
Future editor or incremental parsing.
```

### Risks

```text
It adds a second representation.
Memory can get worse if both internal tapes and public event arrays are retained.
Tree builder must consume internal records directly or public events are still allocated.
Adapter complexity increases.
Debugging gets harder.
```

### Current recommendation

Do not start here.

Keep it as a later option if public-event-only lazy variants do not produce enough benefit, or if session/analyze replay caches become the clear bottleneck.

## Approach 8: Numeric IDs versus string discriminants

### String shape

```ts
export type InternalEventKind =
	| "enter"
	| "exit"
	| "text"
	| "token"
	| "error";
```

### Numeric shape

```ts
export const InternalEventKind = Object.freeze({
	enter: 1,
	exit: 2,
	text: 3,
	token: 4,
	error: 5,
} as const);
```

### Reasoning

String discriminants are easier to debug, match the public API, and avoid adapter tables. Numeric IDs become useful when events are packed into typed arrays or a compact internal tape.

### Current recommendation

Keep string `kind`, `node_type`, and `token_type` while testing public-event-only variants.

Do not introduce numeric IDs unless we adopt an internal tape or benchmarks show string comparisons are a real cost.

## Approach 9: Discontiguous text groups

### Shape

Current text events represent contiguous ranges:

```text
text [start, end)
```

A possible future handoff could group multiple ranges:

```text
text group
  span [line 1 start, line 1 end)
  span [line 2 start, line 2 end)
  span [line 3 start, line 3 end)
```

### Reasoning

Paragraph continuation lines may be logically part of one inline group, while the physical newline remains structural and is not emitted as ordinary text.

A discontiguous handoff could reduce setup and repeated scanning for long paragraph groups.

### Risks

```text
This changes an internal contract.
It must not pretend omitted structural newlines are plain text.
Inline parsing across spans becomes more complex.
Correctness around links, templates, apostrophes, and bare URLs needs careful tests.
```

### Current recommendation

Do not combine this with event-shape experiments.

It is a separate parser-handoff experiment and should be benchmarked later.

## Prototype and object-shape rules

The point is not “use prototypes because prototypes are fast.” The point is to keep object shapes predictable.

Rules:

```text
Same event kind, same property order.
Same property name, same descriptor style.
Do not sometimes use data `props` and sometimes getter `props` in the same variant.
Do not sometimes include optional fields and sometimes omit them unless that is already the chosen event shape.
Do not return fresh empty objects from getters.
Memoize expensive lazy fields after first access.
Keep offsets eager because they are the cheap path.
Keep discriminants eager because switches need them.
```

For public compatibility, own lazy getters are easier to test than class-backed events. For implementation cleanliness, class-backed events may share getter code better. The benchmark should decide whether either path earns its cost.

## Benchmark plan

### Decision rule

Keep a variant only if it meets all of these:

```text
Improves the target benchmark by at least 5 to 10 percent.
Does not regress critical paths by more than 2 to 3 percent.
Shows allocation or retained-memory improvement in the expected path.
Repeats across multiple process runs.
Does not break public behavior tests.
```

If the result is not statistically meaningful, keep the current approach.

### Variants to test

```text
A. Current eager public events.
B. Eager positions plus shared empty/interned tiny props.
C. Own lazy memoized position.
D. Own lazy memoized position plus shared/interned eager props.
E. Own lazy memoized position plus lazy source-sliced props.
F. Class/prototype-backed event objects.
```

### Benchmark lanes

Add drains that isolate access patterns:

```ts
export function drainEventsNoPosition(input: string): number {
	let count = 0;

	for (const event of events(input)) {
		count += event.kind.length;
	}

	return count;
}
```

```ts
export function drainEventsOffsetsOnly(input: string): number {
	let checksum = 0;

	for (const event of events(input)) {
		if (event.kind === "text") {
			checksum += event.start_offset;
			checksum += event.end_offset;
		}
	}

	return checksum;
}
```

```ts
export function drainEventsWithPosition(input: string): number {
	let checksum = 0;

	for (const event of events(input)) {
		checksum += event.position.start.offset;
		checksum += event.position.end.offset;
	}

	return checksum;
}
```

```ts
export function drainEnterProps(input: string): number {
	let checksum = 0;

	for (const event of events(input)) {
		if (event.kind === "enter") {
			checksum += Object.keys(event.props).length;
		}
	}

	return checksum;
}
```

Also keep real workflow lanes:

```text
parse(input)
parseWithDiagnostics(input)
outlineEvents(input)
events(input)
session cold events
session warm events
session cold parse
session warm parse
```

### Fixture coverage

Use the existing fixture families:

```text
plain prose
word-boundary/token-density stress
headings
tables
links
templates
mixed documents
pathological malformed input
inline-heavy documents
Unicode documents
synthetic articles
large streaming article
```

These fixtures already cover the cases where event count, inline density, source slicing, and malformed recovery can behave differently.

### Memory measurement

Timing is not enough. Add separate memory measurements outside hot benchmark loops.

```ts
function forceGc(): void {
	for (let index = 0; index < 3; index++) {
		globalThis.gc?.();
	}
}

function heapUsed(): number {
	forceGc();
	return Deno.memoryUsage().heapUsed;
}

export function measureRetainedEvents(input: string): number {
	forceGc();
	const before = heapUsed();

	const retained = Array.from(events(input));

	forceGc();
	const after = heapUsed();

	if (retained.length === 0) {
		throw new Error("expected events");
	}

	return after - before;
}
```

Measure these cases separately:

```text
Retain events without reading position.
Retain events then read every position.
Retain events then read every props.
Session warm event cache.
parse(input).
parseWithDiagnostics(input).
```

## Expected outcomes

### If Variant D wins

Use lazy memoized `position` and shared/interned eager props.

This is the best likely outcome because it targets eager position allocation without making props too clever.

### If only Variant B wins

Keep shared empty props and interned tiny props. Leave positions eager.

This would mean lazy position complexity did not earn its keep.

### If lazy position wins only when position is never read

Decide based on target consumers.

If offset-only event consumers are important, it may still be worth it. If most real users call `parse()` or read positions anyway, keep the eager model.

### If class-backed events win

Only consider adopting them if public behavior remains acceptable.

A performance win is not enough if it breaks plain-object expectations.

### If no variant clearly wins

Revert to the current event constructors.

That is a valid result. It means the current simple shape is good enough, and the repo avoids unnecessary complexity.

## Recommended experiment order

```text
1. Add benchmark drains and memory measurement scripts.
2. Record baseline results from current main.
3. Test shared empty/interned props.
4. Test own lazy memoized position.
5. Test lazy position plus interned props.
6. Test lazy source-sliced props only if props show meaningful cost.
7. Test class-backed events only if own getters are promising but not ideal.
8. Keep the simplest variant that wins clearly.
9. Revert if results are not statistically meaningful.
```

## Recommended first bet

The first serious candidate should be:

```text
Lazy memoized position + shared/interned eager props.
```

This balances performance, public compatibility, and implementation risk.

It also aligns with the repo's current performance model: remove repeated work, avoid eager position allocation where it is not needed, and preserve the exact source ranges reported by the parser.

## Final framing

The maintainable position is:

```text
Public WikitextEvent objects remain the parser's event model.
Offsets and discriminants stay eager.
Positions can be lazy if benchmarks prove the win.
Props stay eager unless a specific props category proves expensive.
Internal tapes remain a later option for replay-heavy session/analyze paths.
```

The benchmark should decide whether the added complexity is justified. If not, the current eager event constructors are the right design.


</background>

<docs>

Yes. I would approach this like a controlled parser experiment, not like a refactor. The goal is not to prove the lazy getter idea right. The goal is to find out whether it wins clearly enough to deserve the complexity.

Your repo already has the right performance contract: optimize by removing repeated work without changing reported source ranges, keep range-first data intact, and isolate event creation, position calculation, and nested position-object allocation as measurable costs.  The current event constructors are also simple and stable, which gives us a clean baseline: `enterEvent`, `exitEvent`, `textEvent`, `tokenEvent`, and `errorEvent` all create fresh public event objects today.  

## The decision rule

I would set the rule before writing code:

> Keep a variant only if it improves the target benchmark by at least 5 to 10 percent, does not regress any critical benchmark by more than 2 to 3 percent, and reduces allocation or memory in the expected path. Otherwise, keep the current approach.

For this kind of micro-optimization, a tiny “win” is not enough. Lazy getters add conceptual cost, descriptor behavior, and potential shape transitions. If the benchmark result is noise, the current eager object model is better.

Your previous repository test already pointed in this direction: soften certainty, test the exact claim, and revert if the evidence is not clear. 

## What we should test

I would not jump straight from current eager events to “everything lazy.” Test narrow variants.

### Variant A: current baseline

This is the current implementation:

```ts
return { kind: "text", start_offset, end_offset, position };
```

This establishes the control.

### Variant B: eager position, shared empty props, interned tiny props

This keeps the current eager position behavior, but reduces avoidable props allocation.

Examples:

```ts
const EMPTY_PROPS: Readonly<Record<string, never>> = Object.freeze({});

const HEADING_PROPS = Object.freeze([
	undefined,
	Object.freeze({ level: 1 as const }),
	Object.freeze({ level: 2 as const }),
	Object.freeze({ level: 3 as const }),
	Object.freeze({ level: 4 as const }),
	Object.freeze({ level: 5 as const }),
	Object.freeze({ level: 6 as const }),
] as const);
```

This is the least risky optimization. It may give some memory benefit without changing `position`.

### Variant C: own lazy memoized `position`

This keeps plain objects, but makes `position` lazy.

```ts
function defineLazyPosition<T extends object>(
	event: T,
	create_position: () => Position,
): T & { readonly position: Position } {
	Object.defineProperty(event, "position", {
		enumerable: true,
		configurable: true,

		get() {
			const position = create_position();

			Object.defineProperty(event, "position", {
				enumerable: true,
				configurable: false,
				value: position,
			});

			return position;
		},
	});

	return event as T & { readonly position: Position };
}
```

This tests the core idea without touching props.

### Variant D: own lazy memoized `position` plus shared/interned eager props

This is probably the most realistic candidate.

```text
position:
  lazy and memoized

props:
  eager, but EMPTY_PROPS and tiny fixed props are shared
```

This avoids closure-heavy lazy props while attacking the position cost.

### Variant E: own lazy memoized `position` plus lazy source-sliced props

Only source-sliced or parsed props become lazy:

```text
target
name
value
url
attributes
```

Tiny props stay shared/eager.

This tests whether delaying string slicing helps enough.

### Variant F: prototype/class-backed event objects

This tests the “shared getter function” version.

```ts
class TextEventObject {
	readonly kind = "text" as const;
	readonly start_offset: number;
	readonly end_offset: number;

	#position?: Position;
	readonly #create_position: () => Position;

	constructor(
		start_offset: number,
		end_offset: number,
		create_position: () => Position,
	) {
		this.start_offset = start_offset;
		this.end_offset = end_offset;
		this.#create_position = create_position;
	}

	get position(): Position {
		this.#position ??= this.#create_position();
		return this.#position;
	}
}
```

I would test this, but I would expect more public API compatibility questions because class/prototype getters are less like plain JSON-ish event objects.

## The hidden-class rule we should follow

For each variant, keep one rule:

> Same event kind, same property order, same descriptor style.

So do not mix this inside the same variant:

```ts
// Bad: some enter events use data props.
{ kind: "enter", node_type, props, position }

// Bad: other enter events use accessor props.
{ kind: "enter", node_type, get props() { return props; }, position }
```

Pick one shape per variant and stick to it. The event union can have different shapes by kind, but all `TextEvent`s should look like all other `TextEvent`s, all `EnterEvent`s should look like all other `EnterEvent`s, and so on.

For the first pass, I would keep this shape policy:

```text
kind:
  always eager string

node_type/token_type/start_offset/end_offset/message:
  always eager

position:
  either always eager or always lazy per variant

props:
  either always eager on enter events or always lazy on enter events per variant
```

## Benchmarks we need

The existing fixtures are a good base. They already cover plain text, token-density stress, headings, tables, links, templates, mixed text, pathological input, inline-heavy text, Unicode fixtures, synthetic articles, and a large streaming article.  

I would add benchmark drains that isolate property access patterns.

### 1. Event creation without reading position

This is where lazy `position` should win.

```ts
export function drainEventsNoPosition(input: string): number {
	let count = 0;

	for (const event of events(input)) {
		count += event.kind.length;
	}

	return count;
}
```

### 2. Event creation while reading offsets only

This matches range-first consumers.

```ts
export function drainEventsOffsetsOnly(input: string): number {
	let checksum = 0;

	for (const event of events(input)) {
		if (event.kind === "text") {
			checksum += event.start_offset;
			checksum += event.end_offset;
		}
	}

	return checksum;
}
```

### 3. Event creation while reading every position

This is where lazy `position` may lose or break even.

```ts
export function drainEventsWithPosition(input: string): number {
	let checksum = 0;

	for (const event of events(input)) {
		checksum += event.position.start.offset;
		checksum += event.position.end.offset;
	}

	return checksum;
}
```

### 4. Enter props access

This isolates `props`.

```ts
export function drainEnterProps(input: string): number {
	let checksum = 0;

	for (const event of events(input)) {
		if (event.kind === "enter") {
			checksum += Object.keys(event.props).length;
		}
	}

	return checksum;
}
```

### 5. Parse tree path

This tells us whether the real public `parse()` path benefits.

```ts
export function drainParseTree(input: string): number {
	return parse(input).children.length;
}
```

### 6. Diagnostics path

This matters because diagnostics heavily rely on positions.

```ts
export function drainDiagnostics(input: string): number {
	const result = parseWithDiagnostics(input);
	return result.tree.children.length + result.diagnostics.length;
}
```

### 7. Session warm and cold

The repo already has warm/cold session drains. Keep those because lazy fields may behave differently when events are cached and reused. 

## Statistical approach

I would use two layers.

### First pass: mitata benchmark comparison

Use mitata for iteration speed. You already use it in benchmark files, and the tokenizer benchmark consumes results with `do_not_optimize()` and uses `.gc("inner")`, which is the right style for allocation-sensitive comparisons. 

Run each variant several times, preferably in separate processes:

```bash
deno task bench:event-shapes
deno task bench:event-shapes
deno task bench:event-shapes
deno task bench:event-shapes
deno task bench:event-shapes
```

Do not compare one run to one run.

### Second pass: saved JSON or CSV results

For significance, save results from repeated process runs. Then compare distributions.

For each benchmark and variant, collect:

```text
mean
median
standard deviation
95% confidence interval
relative change versus baseline
peak heap or heap delta after GC
```

A result is convincing only if:

```text
confidence intervals do not meaningfully overlap
effect size is large enough to matter
the same direction appears across repeated process runs
memory improves or stays neutral
```

For microbenchmarks, I would not accept a 1 to 2 percent improvement. That is too easy to lose to JIT, CPU frequency, GC timing, or machine noise.

## Memory measurement

Timing alone is not enough here because your concern is memory.

Add a memory script separate from hot-loop timing. Do not mix heap measurement inside mitata loops.

Example shape:

```ts
function forceGc(): void {
	for (let index = 0; index < 3; index++) {
		globalThis.gc?.();
	}
}

function heapUsed(): number {
	forceGc();
	return Deno.memoryUsage().heapUsed;
}

function measureRetainedEvents(input: string): number {
	forceGc();
	const before = heapUsed();

	const retained = Array.from(events(input));

	forceGc();
	const after = heapUsed();

	// Consume retained so it cannot be optimized away.
	if (retained.length === 0) throw new Error("expected events");

	return after - before;
}
```

Measure separate cases:

```text
Array.from(events(input)) without reading position
Array.from(events(input)) then read every position
Array.from(events(input)) then read every props
session.events() warm cache
parse(input)
parseWithDiagnostics(input)
```

This matters because lazy getters can reduce initial retained memory but increase memory after all positions are read.

## What results would mean

### Lazy position wins clearly

Keep it if:

```text
events without position access improves meaningfully
offset-only consumers improve meaningfully
retained event memory drops meaningfully
parse() does not regress meaningfully
position-heavy consumers do not regress too much
```

This would support Variant D.

### Lazy position only wins when nobody reads position

That may still be worth it if your target users often consume offset-only events. But if `parse()` and common consumers always touch `position`, the win may not justify the complexity.

### Lazy props does not clearly win

Drop it. Keep shared `EMPTY_PROPS` and interned tiny props instead.

### Class/prototype events win but change object behavior

Be careful. A performance win may not be worth making events feel less like plain objects unless the win is large.

### No statistically significant difference

Revert. Keep current constructors. Maybe keep only `EMPTY_PROPS` and interned tiny props if they are behavior-neutral and measurable.

## My recommended branch strategy

Use separate branches or commits so each variant can be benchmarked cleanly:

```text
baseline/current

bench/event-shape-b-empty-props
bench/event-shape-c-lazy-position-own
bench/event-shape-d-lazy-position-interned-props
bench/event-shape-e-lazy-position-lazy-sliced-props
bench/event-shape-f-class-backed-events
```

Each branch should include:

```text
implementation
same test suite
same benchmark harness
same benchmark fixtures
same result collection script
```

Do not stack variants on top of each other unless that variant is explicitly cumulative.

## The approach I would personally bet on

I would bet on this variant first:

```text
D: lazy memoized position + shared/interned eager props
```

Because it targets the cost the repo already identifies, keeps the public event object model mostly intact, avoids over-lazying props, and should benefit offset-only event consumers.

I would be skeptical of lazy props until measured. `props` can become a closure factory trap if we are not careful.

## The final plan

1. Add benchmark drains for no-position, offsets-only, all-position, and props access.
2. Add memory measurement scripts separate from timing benchmarks.
3. Run the current baseline and save results.
4. Test Variant B, because it is low risk.
5. Test Variant C/D, because lazy position is the main hypothesis.
6. Test Variant E only if props allocation shows up as meaningful.
7. Test Variant F only if own getters show overhead or memory pressure.
8. Keep the simplest variant that wins clearly.
9. Revert to current eager constructors if the results are not statistically meaningful.

That gives you a disciplined path: try the idea seriously, protect the parser’s source-range contract, and avoid adopting complexity unless the numbers actually earn it.


</docs>