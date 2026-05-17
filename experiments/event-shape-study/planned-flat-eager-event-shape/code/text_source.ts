/**
 * A small text interface for the whole parser pipeline.
 *
 * The parser reads source text one character at a time. In the common case,
 * that source is just a normal JavaScript string. In an editor or live
 * collaboration system, the source might live in a rope or CRDT buffer
 * instead. This file gives the parser one small shape it can rely on, so the
 * rest of the code does not care where the text came from.
 *
 * In practice that means all parser stages can work with the same input style:
 *
 * ```
 * plain string
 * rope-backed editor buffer
 * CRDT-backed document
 *        │
 *        └── implements TextSource
 *                │
 *                ▼
 *        tokenizer -> events -> tree builder
 * ```
 *
 * A plain string already works with no wrapper because it already has the
 * methods we need: `length`, `charCodeAt()`, and `slice()`.
 *
 * Why these three methods?
 *
 * - `length` tells the scanner when to stop.
 * - `charCodeAt()` lets the tokenizer check one character at a time in its
 *   hottest loop without creating a new one-character string for every check.
 * - `slice()` turns a stored range back into real text only when a later stage
 *   or consumer actually needs the text.
 *
 * That last point matters. Tokens and events mostly store start and end
 * offsets, not copied strings. So instead of creating tiny strings all the
 * time during scanning, the parser keeps cheap numeric ranges and resolves the
 * real text on demand.
 *
 * ```ts
 * const value = source.slice(token.start, token.end);
 * ```
 *
 * This keeps the hot path simpler and avoids extra allocation pressure while
 * scanning large articles.
 *
 * @example Using a plain string directly
 * ```ts
 * import type { TextSource } from './text_source.ts';
 *
 * const source: TextSource = '== Heading ==\nSome text.';
 * source.charCodeAt(0); // 61
 * source.slice(0, 13);  // '== Heading =='
 * source.length;        // 24
 * ```
 *
 * @example Adapting a custom backing store
 * ```ts
 * import type { TextSource } from './text_source.ts';
 *
 * class RopeSource implements TextSource {
 *   readonly length: number;
 *
 *   constructor(
 *     private readonly rope: {
 *       charAt(i: number): string;
 *       toString(): string;
 *       length: number;
 *     },
 *   ) {
 *     this.length = rope.length;
 *   }
 *
 *   charCodeAt(index: number): number {
 *     return this.rope.charAt(index).charCodeAt(0);
 *   }
 *
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
