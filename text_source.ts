/**
 * Text source abstraction that lets the parser accept plain strings, ropes,
 * and CRDT buffers through one interface.
 *
 * A plain JavaScript `string` already satisfies {@linkcode TextSource}
 * (`length`, `charCodeAt`, and `slice` are built in), so the common case
 * needs no wrapper. Editors backed by ropes or CRDTs implement the same
 * three methods and feed their buffers directly into the parser, without
 * serializing to a flat string first.
 *
 * The payoff: one tokenizer, one event stream, one AST builder -- all
 * source-representation-agnostic.
 *
 * ```
 * ┌────────────────────────────────────────────┐
 * │               TextSource                   │
 * │  (length, charCodeAt, slice, iterSlices?)  │
 * └──────────────────┬─────────────────────────┘
 *                    │
 *         implements │
 *      ┌─────────────┼──────────────┐
 *      │             │              │
 *   plain string   Rope tree    CRDT buffer
 *      │             │              │
 *      └─────────────┴──────────────┘
 *                    │
 *                    ▼
 *            Tokenizer (hot loop)
 *            calls charCodeAt(i)
 *            on every character
 * ```
 *
 * The tokenizer scans every character by calling `source.charCodeAt(i)`
 * in a tight inner loop. This is the single hottest call in the parser.
 * Using numeric codes (not `charAt` strings) avoids allocating a
 * one-character string per comparison, which matters at millions of
 * characters per second on large articles.
 *
 * ```ts
 * // Simplified tokenizer loop -- runs once per character
 * while (i < source.length) {
 *   const code = source.charCodeAt(i);    // hot call
 *   if (code >= 128 || !DELIMITER[code]) {
 *     // absorb non-delimiter text
 *   } else {
 *     // handle delimiter
 *   }
 * }
 * ```
 *
 * For a plain `string`, `charCodeAt` is a single indexed read. For a
 * rope-backed editor, the implementation might traverse tree nodes. The
 * interface hides this difference so the parser doesn't need to care.
 *
 * Tokens and events carry start/end offsets rather than extracted strings.
 * `slice` is called only when a consumer actually needs the text content
 * (to build a template name, render HTML, or display a node value):
 *
 * ```ts
 * const value = source.slice(token.start, token.end);
 * ```
 *
 * Keeping `slice` out of the hot loop avoids per-token string allocation
 * and prevents V8 sliced-string retention (where a small `.slice()` can
 * pin the entire parent string in memory).
 *
 * @example Creating a TextSource from a plain string
 * ```ts
 * import type { TextSource } from './text_source.ts';
 *
 * // A plain string already satisfies the interface -- no wrapper needed.
 * const source: TextSource = '== Heading ==\nSome text.';
 * source.charCodeAt(0); // 61 (code for '=')
 * source.slice(0, 13);  // '== Heading =='
 * source.length;         // 24
 * ```
 *
 * @example Satisfying TextSource with a custom backing store
 * ```ts
 * import type { TextSource } from './text_source.ts';
 *
 * class RopeSource implements TextSource {
 *   readonly length: number;
 *   constructor(private rope: { charAt(i: number): string; toString(): string; length: number }) {
 *     this.length = rope.length;
 *   }
 *   charCodeAt(index: number): number {
 *     return this.rope.charAt(index).charCodeAt(0);
 *   }
 *   slice(start: number, end: number): string {
 *     return this.rope.toString().slice(start, end);
 *   }
 * }
 * ```
 *
 * @module
 */

/**
 * Minimal read-only text interface consumed by all parser pipeline stages.
 *
 * Any object that exposes `length`, `charCodeAt`, and `slice` with the same
 * semantics as the built-in `String` prototype satisfies this interface.
 * A plain `string` works out of the box:
 *
 * ```ts
 * const src: TextSource = 'hello';  // ✓ no wrapper needed
 * ```
 *
 * `iterSlices` is an optional optimization hook for chunked consumers
 * (e.g., streaming serializers that want to avoid concatenating the entire
 * source into a single string).
 */
export interface TextSource {
  /** Total length in UTF-16 code units. */
  readonly length: number;

  /**
   * Return the UTF-16 character code at the given offset.
   *
   * Must behave identically to `String.prototype.charCodeAt`: return
   * `NaN` for out-of-range indices.
   *
   * This is the single hottest method in the parser. The tokenizer's
   * inner loop calls it on every character position. We use `charCodeAt`
   * (not `charAt`) because comparing numeric codes avoids allocating a
   * one-character string per comparison, which matters at scan speeds of
   * millions of characters per second.
   *
   * @param index - Zero-based UTF-16 code unit offset.
   */
  charCodeAt(index: number): number;

  /**
   * Return the substring from `start` (inclusive) to `end` (exclusive),
   * measured in UTF-16 code units.
   *
   * Must behave identically to `String.prototype.slice` for non-negative
   * indices within bounds.
   *
   * @param start - Inclusive start offset.
   * @param end - Exclusive end offset.
   */
  slice(start: number, end: number): string;

  /**
   * Optional: iterate sub-slices of the range `[start, end)` without
   * concatenating into a single string first. Useful for chunked
   * serialization or streaming output where the backing store is
   * segmented (e.g., rope nodes, CRDT runs).
   *
   * When absent, consumers fall back to `slice(start, end)`.
   *
   * @param start - Inclusive start offset.
   * @param end - Exclusive end offset.
   */
  iterSlices?(start: number, end: number): Iterable<string>;
}

/**
 * Resolve a range from a {@linkcode TextSource} into a plain string.
 *
 * Throughout the parser, tokens and events carry offset ranges (start/end
 * integers) rather than extracted strings. This is a deliberate performance
 * choice: it avoids allocating a new string for every token and sidesteps
 * V8's sliced-string retention risk, where a small `.slice()` can pin the
 * entire parent string in memory.
 *
 * When a consumer actually needs the text (e.g., to display a node's content
 * or to build a template name), it calls `slice(source, start, end)`. This
 * single call site keeps the string-resolution pattern consistent.
 *
 * @example Resolving a token range to its string value
 * ```ts
 * import { slice } from './text_source.ts';
 *
 * const src = '== Heading ==';
 * slice(src, 3, 10); // 'Heading'
 * ```
 *
 * @example Resolving a zero-length range
 * ```ts
 * import { slice } from './text_source.ts';
 *
 * slice('hello', 2, 2); // ''
 * ```
 *
 * @param source - The text source to read from.
 * @param start - Inclusive start offset (UTF-16 code units).
 * @param end - Exclusive end offset (UTF-16 code units).
 * @returns The resolved substring.
 */
export function slice(source: TextSource, start: number, end: number): string {
  return source.slice(start, end);
}
