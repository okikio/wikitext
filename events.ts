/**
 * Event types for the wikitext parser's event stream.
 *
 * Events are the fundamental interchange format of the parser. The event
 * stream represents the same structural information as the AST but
 * without requiring tree allocation upfront. Consumers choose how much
 * structure to materialize: tree, HTML string, filtered subset, or
 * direct callbacks.
 *
 * Events are **range-first**: text and token events carry offset ranges
 * into the `TextSource`, not allocated strings. A `slice(source, evt)`
 * call resolves the string on demand, matching the offset-based discipline
 * already used by raw tokens.
 *
 * Enter/exit pairs nest like parentheses. The event stream is always
 * well-formed: every `enter(X)` has a matching `exit(X)`, with proper
 * stack discipline.
 *
 * @example Processing a stream of events
 * ```ts
 * import type { WikitextEvent } from './events.ts';
 *
 * function showEvents(events: Iterable<WikitextEvent>) {
 *   for (const evt of events) {
 *     switch (evt.kind) {
 *       case 'enter': console.log(`open ${evt.nodeType}`); break;
 *       case 'exit':  console.log(`close ${evt.nodeType}`); break;
 *       case 'text':  console.log(`text [${evt.startOffset}..${evt.endOffset})`); break;
 *       case 'token': console.log(`token ${evt.tokenType}`); break;
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
 * evt.nodeType; // 'heading'
 * evt.props;    // { level: 2 }
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

/**
 * A specific location in a source file.
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

/**
 * Signals that a node of the given type is being opened.
 *
 * Every `EnterEvent` will have a matching `ExitEvent` with the same
 * `nodeType`, forming a well-nested stack. `props` carries node-specific
 * fields (e.g., `{ level: 2 }` for a heading).
 */
export interface EnterEvent {
  /** Discriminant for the event union. */
  readonly kind: 'enter';
  /** The AST node type being opened (e.g., `'heading'`, `'template'`). */
  readonly nodeType: string;
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
  readonly nodeType: string;
  /** Source range of the closing delimiter / boundary. */
  readonly position: Position;
}

/**
 * A range of literal text content, expressed as offsets into the
 * `TextSource`. Consumers call `slice(source, evt.startOffset, evt.endOffset)`
 * to resolve the string value on demand. This avoids per-event string
 * allocation and prevents memory retention hazards from keeping substrings
 * alive.
 */
export interface TextEvent {
  /** Discriminant for the event union. */
  readonly kind: 'text';
  /** Inclusive start offset (UTF-16 code units into the TextSource). */
  readonly startOffset: number;
  /** Exclusive end offset (UTF-16 code units into the TextSource). */
  readonly endOffset: number;
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
  readonly tokenType: TokenType;
  /** Inclusive start offset (UTF-16 code units into the TextSource). */
  readonly startOffset: number;
  /** Exclusive end offset (UTF-16 code units into the TextSource). */
  readonly endOffset: number;
  /** Source position of this token. */
  readonly position: Position;
}

/**
 * Optional error event emitted at recovery points. The parser never throws;
 * instead it produces valid output and optionally emits these events for
 * consumers that want to log or surface parse issues.
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
 * Switch on `evt.kind` for exhaustive handling. The five variants cover
 * structural open/close (`enter`/`exit`), text content (`text`), raw
 * tokens (`token`), and optional error reporting (`error`).
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

/**
 * Create an `EnterEvent`.
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
 * @param nodeType - The AST node type being opened.
 * @param props - Node-specific fields.
 * @param position - Source range.
 */
export function enterEvent(
  nodeType: string,
  props: Readonly<Record<string, unknown>>,
  position: Position,
): EnterEvent {
  return { kind: 'enter', nodeType, props, position };
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
 * @param nodeType - The AST node type being closed.
 * @param position - Source range of the closing boundary.
 */
export function exitEvent(
  nodeType: string,
  position: Position,
): ExitEvent {
  return { kind: 'exit', nodeType, position };
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
 * @param startOffset - Inclusive start offset (UTF-16 code units).
 * @param endOffset - Exclusive end offset (UTF-16 code units).
 * @param position - Source position.
 */
export function textEvent(
  startOffset: number,
  endOffset: number,
  position: Position,
): TextEvent {
  return { kind: 'text', startOffset, endOffset, position };
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
 * @param tokenType - The token type from the tokenizer.
 * @param startOffset - Inclusive start offset (UTF-16 code units).
 * @param endOffset - Exclusive end offset (UTF-16 code units).
 * @param position - Source position.
 */
export function tokenEvent(
  tokenType: TokenType,
  startOffset: number,
  endOffset: number,
  position: Position,
): TokenEvent {
  return { kind: 'token', tokenType, startOffset, endOffset, position };
}

/**
 * Create an `ErrorEvent`.
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
  return Object.assign(
    { kind: 'error' as const, message, position },
    options,
  );
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

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
 *     evt.nodeType; // string (narrowed)
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
 *     evt.nodeType; // narrowed
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
 *     evt.startOffset; // narrowed
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
 *     evt.tokenType; // narrowed
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
