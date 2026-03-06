/**
 * Event types for the wikitext parser's event stream.
 *
 * Events are the fundamental interchange format of the parser. Rather than
 * producing an AST as the primary output, the parser emits a flat stream of
 * events that encode the same structural information. Consumers then choose
 * how much structure to materialize: a full tree, an HTML string, a filtered
 * subset, or direct callbacks — all from the same event sequence.
 *
 * An AST requires allocating every node upfront. For large articles (200 KB+),
 * this is expensive. An event stream is cheaper to produce and lets
 * consumers bail out early (e.g., "find the first heading and stop"). Events
 * compose well: you can filter, transform, or pipe them without building
 * intermediate trees.
 *
 * ## Enter/exit pairs and stack discipline
 *
 * The event stream uses **enter/exit pairs** with stack discipline, similar
 * to SAX for XML. For the input `== Hello ==\nText`, the event stream
 * looks like:
 *
 * ```
 * enter('heading', { level: 2 })   <- open the heading node
 *   text(3, 8)                     <- "Hello" (offsets, not a string)
 * exit('heading')                  <- close the heading node
 * enter('paragraph')               <- open a paragraph
 *   text(12, 16)                   <- "Text"
 * exit('paragraph')                <- close the paragraph
 * ```
 *
 * The nesting is always well-formed: every `enter(X)` has a matching
 * `exit(X)`, and they nest like parentheses. This guarantee means consumers
 * can track depth with a simple counter or stack.
 *
 * When wikitext nests one element inside another (a link inside a heading,
 * bold inside a template, etc.), the event stream reflects that nesting.
 * This is the key property that lets consumers reconstruct a tree or
 * produce nested HTML tags from a flat sequence.
 *
 * Consider a link inside a heading:
 *
 * ```
 * Source: "== See [[Mars]] =="
 *          0123456789...
 * ```
 *
 * The parser walks through this in order:
 *
 * 1. It sees `==` at position 0 -- opens a heading.
 * 2. It skips the space and sees ordinary text `"See "`.
 * 3. It sees `[[` at position 7 -- opens a wikilink *inside* the heading.
 * 4. It sees `"Mars"` as text inside the link.
 * 5. It sees `]]` at position 15 -- closes the wikilink.
 * 6. It sees `" "` then `==` -- closes the heading.
 *
 * The event stream looks like:
 *
 * ```
 * enter('heading', { level: 2 })      depth 1
 *   text(3, 7)                        "See "
 *   enter('wikilink')                 depth 2
 *     text(9, 13)                     "Mars"
 *   exit('wikilink')                  back to depth 1
 *   text(15, 16)                      " "
 * exit('heading')                     back to depth 0
 * ```
 *
 * The stack discipline is visible in the indentation. A consumer tracking
 * depth would see: 0 -> 1 -> 2 -> 1 -> 0. The enter/exit pairs always
 * nest properly -- you never see `exit('heading')` before
 * `exit('wikilink')`.
 *
 * Text and token events carry **offset ranges** (start/end integers) into
 * the source text, not allocated strings. This range-first approach matches
 * the offset discipline used by raw tokens and avoids per-event string
 * allocation. When a consumer needs the actual text, it calls
 * `slice(source, evt.start_offset, evt.end_offset)`.
 *
 * The five event kinds are:
 *
 * | Kind    | Purpose                                           |
 * |---------|---------------------------------------------------|
 * | `enter` | Opens a node (carries node type + properties)     |
 * | `exit`  | Closes the most recently opened node of that type |
 * | `text`  | A range of literal text content (offsets)         |
 * | `token` | A raw tokenizer token exposed in the stream       |
 * | `error` | Optional recovery event (parser never throws)     |
 *
 * @example Processing a stream of events
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 *
 * function showEvents(events: Iterable<WikitextEvent>) {
 *   for (const evt of events) {
 *     switch (evt.kind) {
 *       case 'enter': console.log(`open ${evt.node_type}`); break;
 *       case 'exit':  console.log(`close ${evt.node_type}`); break;
 *       case 'text':  console.log(`text [${evt.start_offset}..${evt.end_offset})`); break;
 *       case 'token': console.log(`token ${evt.token_type}`); break;
 *     }
 *   }
 * }
 * ```
 *
 * @example Building an enter event
 * ```ts
 * import { enterEvent } from './events.ts';
 *
 * const evt = enterEvent('heading', { level: 2 }, {
 *   start: { line: 1, column: 1, offset: 0 },
 *   end: { line: 1, column: 14, offset: 13 },
 * });
 * evt.kind;     // 'enter'
 * evt.node_type; // 'heading'
 * evt.props;    // { level: 2 }
 * ```
 *
 * @example Tracking depth with a counter
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 *
 * function maxDepth(events: Iterable<WikitextEvent>): number {
 *   let depth = 0;
 *   let max = 0;
 *   for (const evt of events) {
 *     if (evt.kind === 'enter') { depth++; max = Math.max(max, depth); }
 *     if (evt.kind === 'exit') { depth--; }
 *   }
 *   return max;
 * }
 * ```
 *
 * @module
 */

import type { TokenType } from './token.ts';

/**
 * Diagnostic severity level for parser recovery events.
 */
export type DiagnosticSeverity = 'error' | 'warning';

// ---------------------------------------------------------------------------
// Position types (unist-compatible)
// ---------------------------------------------------------------------------
//
// These types track where each event came from in the original source text.
// They follow the unist (Universal Syntax Tree) spec used by the unified
// ecosystem (remark, rehype, etc.), so wikist trees are compatible with
// unist utilities like `unist-util-position`.
//
// All measurements use UTF-16 code units, the native string indexing of
// JavaScript. This matches the Language Server Protocol (LSP), which also
// uses UTF-16 positions. No conversion needed when integrating with editors
// like VS Code.

/**
 * A specific location in a source file.
 *
 * A cursor position in the source: which line, which column, and the
 * absolute character offset from the start of the file.
 *
 * All fields use UTF-16 code unit measurements, matching JS string indexing
 * and LSP's mandatory `utf-16` position encoding.
 */
export interface Point {
  /** 1-indexed line number. */
  readonly line: number;
  /** 1-indexed column, in UTF-16 code units from start of line. */
  readonly column: number;
  /** 0-indexed offset in UTF-16 code units from start of input. */
  readonly offset: number;
}

/**
 * A contiguous range in the source, defined by its start and end points.
 */
export interface Position {
  /** Inclusive start point. */
  readonly start: Point;
  /** Exclusive end point (first character *after* the range). */
  readonly end: Point;
}

// ---------------------------------------------------------------------------
// Event variants
// ---------------------------------------------------------------------------
//
// The five event kinds form a discriminated union on the `kind` field.
// Consumers switch on `evt.kind` for exhaustive handling:
//
//   enter  -> a node is opening (carries type + properties)
//   exit   -> the most recently opened node of that type is closing
//   text   -> a range of literal text (offsets into the source)
//   token  -> a raw tokenizer token surfaced in the event stream
//   error  -> a recovery point (the parser never throws)
//
// Enter/exit pairs always nest properly. If you see:
//   enter('bold') -> enter('italic') -> exit('italic') -> exit('bold')
// the nesting is correct. You will never see exit('bold') before
// exit('italic') -- that would break stack discipline.
//
// Why not carry text strings directly? Because events are produced during
// parsing when millions of characters are being scanned. Allocating a new
// string for every text span would create GC pressure. Instead, text
// events carry start_offset/end_offset pairs. The consumer calls
// `slice(source, start, end)` only when it actually needs the string
// content (e.g., to render HTML or build a node value).
//
// Error events deserve special attention: the parser never throws. If it
// encounters malformed wikitext like an unclosed `{{template`, it recovers
// by treating the `{{` as literal text and optionally emits an ErrorEvent.
// This means consumers always get a complete event stream for any input.

/**
 * Signals that a node of the given type is being opened.
 *
 * Every `EnterEvent` will have a matching {@linkcode ExitEvent} with the same
 * `node_type`, forming a well-nested stack. `props` carries node-specific
 * fields (e.g., `{ level: 2 }` for a heading, `{ ordered: true }` for a
 * list).
 */
export interface EnterEvent {
  /** Discriminant for the event union. */
  readonly kind: 'enter';
  /** The AST node type being opened (e.g., `'heading'`, `'template'`). */
  readonly node_type: string;
  /**
   * Node-specific properties attached at open time.
   *
   * Keyed by field name, values are the property values for the node
   * being opened (e.g., `{ level: 3 }` for a heading, `{ ordered: true }`
   * for a list). Empty object when the node has no extra fields.
   */
  readonly props: Readonly<Record<string, unknown>>;
  /** Source range covered by this event. */
  readonly position: Position;
}

/**
 * Signals that the most recently opened node of the given type is being
 * closed. Matches the corresponding `EnterEvent`.
 */
export interface ExitEvent {
  /** Discriminant for the event union. */
  readonly kind: 'exit';
  /** The AST node type being closed. */
  readonly node_type: string;
  /** Source range of the closing delimiter / boundary. */
  readonly position: Position;
}

/**
 * A range of literal text content, expressed as offsets into the
 * {@linkcode TextSource}.
 *
 * The event does not carry the text string itself: only the start and end
 * offsets. Consumers call `slice(source, evt.start_offset, evt.end_offset)`
 * to resolve the string value on demand. This range-first design avoids
 * per-event string allocation and prevents memory retention hazards from
 * keeping substrings alive.
 *
 * For example, given the source `"== Hello =="`, a text event for the word
 * "Hello" would carry `start_offset: 3` and `end_offset: 8`, without ever
 * allocating the string `"Hello"` until a consumer asks for it.
 */
export interface TextEvent {
  /** Discriminant for the event union. */
  readonly kind: 'text';
  /** Inclusive start offset (UTF-16 code units into the TextSource). */
  readonly start_offset: number;
  /** Exclusive end offset (UTF-16 code units into the TextSource). */
  readonly end_offset: number;
  /** Source position of this text range. */
  readonly position: Position;
}

/**
 * A raw token event, exposing the lowest-level tokenizer output in the
 * event stream. Primarily used by consumers that need token-level
 * granularity without running the tokenizer separately.
 */
export interface TokenEvent {
  /** Discriminant for the event union. */
  readonly kind: 'token';
  /** The token type from the tokenizer. */
  readonly token_type: TokenType;
  /** Inclusive start offset (UTF-16 code units into the TextSource). */
  readonly start_offset: number;
  /** Exclusive end offset (UTF-16 code units into the TextSource). */
  readonly end_offset: number;
  /** Source position of this token. */
  readonly position: Position;
}

/**
 * Optional error event emitted at recovery points. The parser never throws:
 * it always produces valid output for any input. When it encounters malformed
 * wikitext (unclosed templates, mismatched tags, etc.), it recovers and
 * optionally emits an `ErrorEvent` so consumers can log, surface, or ignore
 * the issue.
 *
 * The optional metadata fields (`severity`, `code`, `recoverable`, `source`,
 * `details`) support richer diagnostics. They are all optional so that the
 * simplest error case is just a message and a position.
 */
export interface ErrorEvent {
  /** Discriminant for the event union. */
  readonly kind: 'error';
  /** Human-readable description of what was recovered from. */
  readonly message: string;
  /**
   * Diagnostic severity. Defaults to `'error'`.
   *
   * Use `'warning'` for softer recoveries that may still be semantically
   * acceptable for many consumers.
   */
  readonly severity?: DiagnosticSeverity;
  /**
   * Stable machine-readable code for programmatic filtering and telemetry.
   */
  readonly code?: string;
  /**
   * Indicates whether parsing continued with a deterministic recovery path.
   */
  readonly recoverable?: boolean;
  /**
   * Parser stage that emitted this diagnostic.
   */
  readonly source?: 'tokenizer' | 'block' | 'inline' | 'tree';
  /**
   * Optional structured details for advanced consumers.
   */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Source position where the error was detected. */
  readonly position: Position;
}

/**
 * Optional metadata for {@linkcode ErrorEvent} construction.
 */
export interface ErrorEventOptions {
  /** Severity level for this diagnostic. */
  readonly severity?: DiagnosticSeverity;
  /** Stable machine-readable code. */
  readonly code?: string;
  /** Whether the parser recovered and continued. */
  readonly recoverable?: boolean;
  /** Parser stage that emitted the diagnostic. */
  readonly source?: 'tokenizer' | 'block' | 'inline' | 'tree';
  /** Optional structured metadata payload. */
  readonly details?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all event types in the wikitext event stream.
 *
 * Switch on `evt.kind` for exhaustive handling:
 *
 * ```ts
 * switch (evt.kind) {
 *   case 'enter': // open a node
 *   case 'exit':  // close a node
 *   case 'text':  // text content (offsets)
 *   case 'token': // raw token
 *   case 'error': // recovery point
 * }
 * ```
 *
 * TypeScript will narrow the type inside each branch, giving access to the
 * fields specific to that event kind (e.g., `evt.node_type` is only available
 * inside the `'enter'` and `'exit'` branches).
 */
export type WikitextEvent =
  | EnterEvent
  | ExitEvent
  | TextEvent
  | TokenEvent
  | ErrorEvent;

// ---------------------------------------------------------------------------
// Event constructors
// ---------------------------------------------------------------------------
//
// Factory functions for creating event objects. Each returns a fresh
// immutable object. These are the primary way to build events — prefer
// these over hand-constructing event objects, because they enforce the
// correct `kind` discriminant and field names.

/**
 * Create an {@linkcode EnterEvent}.
 *
 * @example Opening a heading node
 * ```ts
 * import { enterEvent } from './events.ts';
 *
 * const evt = enterEvent('heading', { level: 2 }, {
 *   start: { line: 1, column: 1, offset: 0 },
 *   end: { line: 1, column: 14, offset: 13 },
 * });
 * ```
 *
 * @example Opening a simple paragraph
 * ```ts
 * import { enterEvent } from './events.ts';
 *
 * const evt = enterEvent('paragraph', {}, {
 *   start: { line: 3, column: 1, offset: 20 },
 *   end: { line: 3, column: 1, offset: 20 },
 * });
 * ```
 *
 * @param node_type - The AST node type being opened.
 * @param props - Node-specific fields.
 * @param position - Source range.
 */
export function enterEvent(
  node_type: string,
  props: Readonly<Record<string, unknown>>,
  position: Position,
): EnterEvent {
  return { kind: 'enter', node_type, props, position };
}

/**
 * Create an `ExitEvent`.
 *
 * @example Closing a heading node
 * ```ts
 * import { exitEvent } from './events.ts';
 *
 * const evt = exitEvent('heading', {
 *   start: { line: 1, column: 1, offset: 0 },
 *   end: { line: 1, column: 14, offset: 13 },
 * });
 * ```
 *
 * @example Closing a paragraph
 * ```ts
 * import { exitEvent } from './events.ts';
 *
 * const evt = exitEvent('paragraph', {
 *   start: { line: 5, column: 1, offset: 50 },
 *   end: { line: 5, column: 1, offset: 50 },
 * });
 * ```
 *
 * @param node_type - The AST node type being closed.
 * @param position - Source range of the closing boundary.
 */
export function exitEvent(
  node_type: string,
  position: Position,
): ExitEvent {
  return { kind: 'exit', node_type, position };
}

/**
 * Create a `TextEvent` with range-first offsets.
 *
 * @example A text range for inline content
 * ```ts
 * import { textEvent } from './events.ts';
 *
 * const evt = textEvent(3, 10, {
 *   start: { line: 1, column: 4, offset: 3 },
 *   end: { line: 1, column: 11, offset: 10 },
 * });
 * ```
 *
 * @example An empty text range
 * ```ts
 * import { textEvent } from './events.ts';
 *
 * const evt = textEvent(5, 5, {
 *   start: { line: 1, column: 6, offset: 5 },
 *   end: { line: 1, column: 6, offset: 5 },
 * });
 * ```
 *
 * @param start_offset - Inclusive start offset (UTF-16 code units).
 * @param end_offset - Exclusive end offset (UTF-16 code units).
 * @param position - Source position.
 */
export function textEvent(
  start_offset: number,
  end_offset: number,
  position: Position,
): TextEvent {
  return { kind: 'text', start_offset, end_offset, position };
}

/**
 * Create a `TokenEvent`.
 *
 * @example A heading marker token event
 * ```ts
 * import { tokenEvent } from './events.ts';
 * import { TokenType } from './token.ts';
 *
 * const evt = tokenEvent(TokenType.HEADING_MARKER, 0, 2, {
 *   start: { line: 1, column: 1, offset: 0 },
 *   end: { line: 1, column: 3, offset: 2 },
 * });
 * ```
 *
 * @example A newline token event
 * ```ts
 * import { tokenEvent } from './events.ts';
 * import { TokenType } from './token.ts';
 *
 * const evt = tokenEvent(TokenType.NEWLINE, 13, 14, {
 *   start: { line: 1, column: 14, offset: 13 },
 *   end: { line: 2, column: 1, offset: 14 },
 * });
 * ```
 *
 * @param token_type - The token type from the tokenizer.
 * @param start_offset - Inclusive start offset (UTF-16 code units).
 * @param end_offset - Exclusive end offset (UTF-16 code units).
 * @param position - Source position.
 */
export function tokenEvent(
  token_type: TokenType,
  start_offset: number,
  end_offset: number,
  position: Position,
): TokenEvent {
  return { kind: 'token', token_type, start_offset, end_offset, position };
}

/**
 * Create an {@linkcode ErrorEvent}.
 *
 * The simplest form takes just a message and position. Pass an
 * {@linkcode ErrorEventOptions} object to attach structured diagnostic
 * metadata (severity, machine-readable code, recovery status, source
 * stage, and arbitrary details).
 *
 * @example Emitting an error for an unclosed template
 * ```ts
 * import { errorEvent } from './events.ts';
 *
 * const evt = errorEvent('Unclosed template at end of input', {
 *   start: { line: 5, column: 1, offset: 42 },
 *   end: { line: 5, column: 3, offset: 44 },
 * });
 * ```
 *
 * @example An error for malformed table syntax
 * ```ts
 * import { errorEvent } from './events.ts';
 *
 * const evt = errorEvent('Malformed table row', {
 *   start: { line: 10, column: 1, offset: 100 },
 *   end: { line: 10, column: 3, offset: 102 },
 * }, {
 *   severity: 'warning',
 *   code: 'TABLE_ROW_MALFORMED',
 *   recoverable: true,
 *   source: 'block',
 * });
 * ```
 *
 * @param message - Human-readable description.
 * @param position - Source position where the error was detected.
 * @param options - Optional structured diagnostic metadata.
 */
export function errorEvent(
  message: string,
  position: Position,
  options: ErrorEventOptions = {},
): ErrorEvent {
  // Object.assign merges the base fields with any optional metadata in a
  // single allocation. Only the fields present in `options` are included,
  // so a simple errorEvent('msg', pos) produces { kind, message, position }
  // without undefined keys for severity, code, etc.
  return Object.assign(
    { kind: 'error' as const, message, position },
    options,
  );
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------
//
// Type guards let consumers narrow a `WikitextEvent` to a specific variant.
// TypeScript's type system uses the return type `event is EnterEvent` (a
// "type predicate") to narrow the type inside an `if` block or `.filter()`.
//
// These are thin wrappers around `event.kind === '...'`, but they're useful
// for passing as callbacks (e.g., `events.filter(isEnterEvent)`) where an
// inline arrow function would be noisier.

/**
 * Check whether a `WikitextEvent` is an `EnterEvent`.
 *
 * @example Filtering for enter events
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isEnterEvent } from './events.ts';
 *
 * function countEnters(events: WikitextEvent[]): number {
 *   return events.filter(isEnterEvent).length;
 * }
 * ```
 *
 * @example Narrowing in a switch
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isEnterEvent } from './events.ts';
 *
 * function handleEvent(evt: WikitextEvent) {
 *   if (isEnterEvent(evt)) {
 *     evt.node_type; // string (narrowed)
 *     evt.props;    // Record<string, unknown> (narrowed)
 *   }
 * }
 * ```
 */
export function isEnterEvent(event: WikitextEvent): event is EnterEvent {
  return event.kind === 'enter';
}

/**
 * Check whether a `WikitextEvent` is an `ExitEvent`.
 *
 * @example Filtering for exit events
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isExitEvent } from './events.ts';
 *
 * const exits = events.filter(isExitEvent);
 * ```
 *
 * @example Narrowing
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isExitEvent } from './events.ts';
 *
 * function handle(evt: WikitextEvent) {
 *   if (isExitEvent(evt)) {
 *     evt.node_type; // narrowed
 *   }
 * }
 * ```
 */
export function isExitEvent(event: WikitextEvent): event is ExitEvent {
  return event.kind === 'exit';
}

/**
 * Check whether a `WikitextEvent` is a `TextEvent`.
 *
 * @example Filtering for text events
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isTextEvent } from './events.ts';
 *
 * const texts = events.filter(isTextEvent);
 * ```
 *
 * @example Narrowing
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isTextEvent } from './events.ts';
 *
 * function handle(evt: WikitextEvent) {
 *   if (isTextEvent(evt)) {
 *     evt.start_offset; // narrowed
 *   }
 * }
 * ```
 */
export function isTextEvent(event: WikitextEvent): event is TextEvent {
  return event.kind === 'text';
}

/**
 * Check whether a `WikitextEvent` is a `TokenEvent`.
 *
 * @example Filtering for token events
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isTokenEvent } from './events.ts';
 *
 * const tokens = events.filter(isTokenEvent);
 * ```
 *
 * @example Narrowing
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isTokenEvent } from './events.ts';
 *
 * function handle(evt: WikitextEvent) {
 *   if (isTokenEvent(evt)) {
 *     evt.token_type; // narrowed
 *   }
 * }
 * ```
 */
export function isTokenEvent(event: WikitextEvent): event is TokenEvent {
  return event.kind === 'token';
}

/**
 * Check whether a `WikitextEvent` is an `ErrorEvent`.
 *
 * @example Collecting parse errors
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isErrorEvent } from './events.ts';
 *
 * const errors = events.filter(isErrorEvent);
 * ```
 *
 * @example Narrowing
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 * import { isErrorEvent } from './events.ts';
 *
 * function handle(evt: WikitextEvent) {
 *   if (isErrorEvent(evt)) {
 *     evt.message; // narrowed
 *   }
 * }
 * ```
 */
export function isErrorEvent(event: WikitextEvent): event is ErrorEvent {
  return event.kind === 'error';
}
