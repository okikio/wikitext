/**
 * Event types for the parser's main output stream.
 *
 * This parser is designed around events first, not tree nodes first. That can
 * sound abstract, so here is the practical version.
 *
 * Sometimes a caller wants the full tree. Sometimes it only wants the first
 * heading, a table of contents, or a stream it can transform on the fly.
 * Building a full AST for every case forces extra work even when the caller
 * does not need it. Events are the cheaper middle layer that all of those
 * outputs can share. The tree builder is just one consumer of that stream.
 *
 * Think of the stream as a running narration of what the parser is finding:
 *
 * - "a heading starts here"
 * - "this text belongs inside it"
 * - "the heading ends here"
 * - "a paragraph starts now"
 *
 * For `== Hello ==\nText`, that looks like this:
 *
 * ```ts
 * enter('heading', { level: 2 })
 *   text(3, 8)   // "Hello"
 * exit('heading')
 * enter('paragraph')
 *   text(12, 16) // "Text"
 * exit('paragraph')
 * ```
 *
 * The important rule is that open and close events stay properly nested. In
 * plain English, if something starts inside a heading, it also has to finish
 * before the heading finishes. That is what parser docs often call stack
 * discipline.
 *
 * ```ts
 * enter('heading')
 *   enter('wikilink')
 *   exit('wikilink')
 * exit('heading')
 * ```
 *
 * You should never see this broken order:
 *
 * ```ts
 * enter('heading')
 *   enter('wikilink')
 * exit('heading')   // wrong
 * exit('wikilink')  // wrong
 * ```
 *
 * Text and token events store source ranges, not copied strings. That means an
 * event says "the text is from offset 3 to offset 8" instead of carrying a new
 * string like `"Hello"`. A caller can recover the real text later with
 * `slice(source, start, end)` when it actually needs it.
 *
 * The five event kinds are:
 *
 * | Kind    | What it means |
 * |---------|----------------|
 * | `enter` | a node starts here |
 * | `exit`  | the matching node ends here |
 * | `text`  | plain text from the source |
 * | `token` | a raw tokenizer token surfaced in the stream |
 * | `error` | recovery information when the parser had to keep going through bad input |
 *
 * @example Processing a stream of events
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 *
 * function showEvents(events: Iterable<WikitextEvent>) {
 *   for (const evt of events) {
 *     switch (evt.kind) {
 *       case 'enter': console.log(`open ${evt.node_type}`); break;
 *       case 'exit': console.log(`close ${evt.node_type}`); break;
 *       case 'text': console.log(`text [${evt.start_offset}..${evt.end_offset})`); break;
 *       case 'token': console.log(`token ${evt.token_type}`); break;
 *       case 'error': console.log(`error ${evt.message}`); break;
 *     }
 *   }
 * }
 * ```
 *
 * @example Tracking the current nesting depth
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 *
 * function maxDepth(events: Iterable<WikitextEvent>): number {
 *   let depth = 0;
 *   let max = 0;
 *
 *   for (const evt of events) {
 *     if (evt.kind === 'enter') {
 *       depth++;
 *       max = Math.max(max, depth);
 *     } else if (evt.kind === 'exit') {
 *       depth--;
 *     }
 *   }
 *
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

/**
 * Stable machine-readable diagnostic codes emitted by the parser itself.
 *
 * This object behaves like an enum without using a TypeScript `enum` runtime.
 * Callers can compare against these values directly:
 *
 * ```ts
 * import { DiagnosticCode } from './events.ts';
 *
 * if (event.kind === 'error' && event.code === DiagnosticCode.UNCLOSED_TABLE) {
 *   // offer a quick fix, surface a warning, or log telemetry
 * }
 * ```
 *
 * The keys group the recoveries the parser currently knows how to describe in
 * a stable way. The human-readable `message` still explains the specific case,
 * but the code is the field consumers should match on.
 *
 * This object is frozen on purpose. It is the parser's own stable vocabulary,
 * not a plugin registration table. Callers that need custom codes can still
 * emit any string through `ErrorEvent.code` or `ParseDiagnostic.code` without
 * mutating the shared parser-owned constant map.
 */
/** Public map shape for the parser's stable diagnostic-code vocabulary. */
export type DiagnosticCodeMap = Readonly<{
  UNCLOSED_TABLE: 'UNCLOSED_TABLE';
  INLINE_TAG_UNTERMINATED_OPENER: 'INLINE_TAG_UNTERMINATED_OPENER';
  INLINE_TAG_MISSING_CLOSE: 'INLINE_TAG_MISSING_CLOSE';
  TREE_MISMATCHED_EXIT: 'TREE_MISMATCHED_EXIT';
  TREE_ORPHAN_EXIT: 'TREE_ORPHAN_EXIT';
  TREE_EOF_AUTOCLOSE: 'TREE_EOF_AUTOCLOSE';
}>;

const DIAGNOSTIC_CODE_VALUES: DiagnosticCodeMap = {
  /**
   * The block parser reached end of input before a table closed with `|}`.
   *
   * Typical input:
   *
   * ```text
   * {| class="wikitable"
   * | Cell
   * ```
   *
   * Reasonable responses include surfacing a warning in an editor, offering a
   * quick fix that inserts `|}`, or ignoring it in a best-effort preview that
   * only needs a usable recovered tree.
   */
  UNCLOSED_TABLE: 'UNCLOSED_TABLE',

  /**
   * The inline parser reached end of input before an HTML-like opener reached
   * its closing `>`.
   *
   * Typical input:
   *
   * ```text
   * <ref name="cite-1"
   * ```
   *
   * The parser preserves the original source as text instead of materializing
   * a tag node, because the opener never became structurally complete.
   */
  INLINE_TAG_UNTERMINATED_OPENER: 'INLINE_TAG_UNTERMINATED_OPENER',

  /**
   * The inline parser recognized an HTML-like opener, but no matching close
   * tag was found before the enclosing text range ended.
   *
   * Typical input:
   *
   * ```text
   * <ref name="cite-1">body
   * ```
   *
   * The parser keeps the opener as structurally real, recovers by extending
   * the node to the end of the current text range, and emits this warning.
   */
  INLINE_TAG_MISSING_CLOSE: 'INLINE_TAG_MISSING_CLOSE',

  /**
   * The tree builder saw an exit for one node while a different node was still
   * open, so it auto-closed the inner node first to restore nesting.
   */
  TREE_MISMATCHED_EXIT: 'TREE_MISMATCHED_EXIT',

  /**
   * The tree builder saw an exit event that did not match any open node and
   * had to drop it at the root boundary.
   */
  TREE_ORPHAN_EXIT: 'TREE_ORPHAN_EXIT',

  /**
   * The event stream ended while one or more nodes were still open, so the
   * tree builder auto-closed them at their last known end point.
   */
  TREE_EOF_AUTOCLOSE: 'TREE_EOF_AUTOCLOSE',
} as const;

/**
 * Stable machine-readable diagnostic codes emitted by the parser today.
 *
 * Match on these values when a consumer needs parser-owned diagnostics that
 * stay stable across messages and formatting changes.
 */
export const DiagnosticCode: DiagnosticCodeMap = Object.freeze(DIAGNOSTIC_CODE_VALUES);

/**
 * Known machine-readable diagnostic codes emitted by the current parser.
 *
 * Callers may still encounter custom string codes from tests, adapters, or
 * future extensions, so event and parse-result shapes keep `code` open to any
 * string. This alias is the stable subset owned by the parser today.
 */
export type KnownDiagnosticCode = typeof DiagnosticCode[keyof typeof DiagnosticCode];

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
 * A single place in the source text.
 *
 * This stores three views of the same location: line number, column number,
 * and absolute offset from the start of the input. All measurements use the
 * same UTF-16 indexing JavaScript strings already use, so positions line up
 * with `charCodeAt()`, `slice()`, and most editor integrations.
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
 * A source range with a start point and an end point.
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
    *
    * When the parser owns the recovery, prefer matching against
    * {@linkcode DiagnosticCode}. That keeps consumers stable even if the
    * human-readable `message` changes.
   */
  readonly code?: KnownDiagnosticCode | string;
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
  /**
   * Stable machine-readable code.
   *
   * Use a {@linkcode DiagnosticCode} member for parser-owned recoveries.
   */
  readonly code?: KnownDiagnosticCode | string;
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
 * The message should explain the local recovery in plain English. The code is
 * what downstream tooling should usually match on.
 *
 * For example, an editor may decide to:
 *
 * - show a gutter warning for malformed input
 * - offer a quick fix for a known missing delimiter
 * - ignore the diagnostic during tolerant preview rendering
 *
 * Those responses are consumer choices, not parser requirements.
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
