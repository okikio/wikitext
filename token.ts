/**
 * Token types and the {@linkcode Token} interface consumed by all parser stages.
 *
 * Tokens are the lowest-level structural unit the parser produces. The
 * tokenizer scans a {@linkcode TextSource} character by character and yields
 * `Token` objects that identify meaningful character sequences: headings,
 * link brackets, bold/italic markers, table delimiters, and so on.
 *
 * Each token stores `start` and `end` offsets into the source text, not
 * extracted string values. Consumers call `slice(source, token.start, token.end)`
 * when they actually need the text. This offset-based design has two benefits:
 *
 * 1. **No per-token allocation**: yielding offsets is cheaper than creating
 *    a new string for every token.
 * 2. **No V8 sliced-string retention**: when you call `str.slice(a, b)`, V8
 *    may keep the entire parent string alive in memory (a "sliced string").
 *    By deferring slicing until the consumer truly needs it, we avoid
 *    accidentally pinning large input strings.
 *
 * ## The const-object pattern (instead of `enum`)
 *
 * `TokenType` is defined as a frozen `const` object rather than a TypeScript
 * `enum`. This pattern produces the same developer experience (autocomplete,
 * exhaustive switch) while being more compatible with tree-shaking, more
 * debuggable (values are human-readable strings, not opaque integers), and
 * standard JavaScript.
 *
 * ```
 * ┌────────────────────────────────────────────┐
 * │             TokenType (const)              │
 * │  TEXT  NEWLINE  HEADING_MARKER  PIPE  ...  │
 * └──────────────────┬─────────────────────────┘
 *                    │
 *        used as discriminant in
 *                    │
 *              ┌─────┴─────┐
 *              │   Token   │
 *              │  { type,  │
 *              │    start, │
 *              │    end }  │
 *              └───────────┘
 * ```
 *
 * @example Reading token fields
 * ```ts
 * import type { Token } from './token.ts';
 * import { TokenType } from './token.ts';
 *
 * const tok: Token = { type: TokenType.HEADING_MARKER, start: 0, end: 2 };
 * tok.type;  // 'HEADING_MARKER' (a string, not a number)
 * tok.start; // 0
 * tok.end;   // 2
 * ```
 *
 * @example Using the type guard
 * ```ts
 * import { isToken, TokenType } from './token.ts';
 *
 * const tok = { type: TokenType.TEXT, start: 5, end: 12 };
 * isToken(tok); // true
 * ```
 *
 * @module
 */

/**
 * Constant map of all token types produced by the tokenizer.
 *
 * Each value represents a distinct class of character sequence recognized
 * during scanning. The tokenizer yields one `Token` per recognized unit;
 * higher-level parsers (block, inline) consume these to emit events.
 *
 * This is a plain `as const` object, not a TypeScript `enum`. The values
 * are human-readable strings (`'TEXT'`, `'HEADING_MARKER'`) rather than
 * opaque numbers, so they show up clearly in logs and debugger output.
 * TypeScript still narrows them to literal types, giving the same
 * exhaustive-switch experience as an enum.
 *
 * Names use UPPER_SNAKE_CASE. Grouped by syntactic role so related tokens
 * are easy to find.
 */
export const TokenType = {
  // -- Text and whitespace --

  /** Literal text content (no special wiki meaning at this position). */
  TEXT: 'TEXT',
  /** Newline sequence: `\n`, `\r\n`, or bare `\r`. */
  NEWLINE: 'NEWLINE',
  /** One or more space or tab characters. */
  WHITESPACE: 'WHITESPACE',

  // -- Heading --

  /** One or more `=` characters at line start (heading open). */
  HEADING_MARKER: 'HEADING_MARKER',
  /** One or more `=` characters at line end (heading close). */
  HEADING_MARKER_CLOSE: 'HEADING_MARKER_CLOSE',

  // -- Lists --

  /** `*` at line start (bullet list marker). */
  BULLET: 'BULLET',
  /** `#` at line start (ordered list marker). */
  HASH: 'HASH',
  /** `:` at line start (definition description / indent). */
  COLON: 'COLON',
  /** `;` at line start (definition term). */
  SEMICOLON: 'SEMICOLON',

  // -- Thematic break --

  /** Four or more `-` at line start (`----`). */
  THEMATIC_BREAK: 'THEMATIC_BREAK',

  // -- Table --

  /** `{|` at line start (table open). */
  TABLE_OPEN: 'TABLE_OPEN',
  /** `|}` at line start (table close). */
  TABLE_CLOSE: 'TABLE_CLOSE',
  /** `|-` at line start (table row separator). */
  TABLE_ROW: 'TABLE_ROW',
  /** `|+` at line start (table caption). */
  TABLE_CAPTION: 'TABLE_CAPTION',
  /** `|` (table cell delimiter or separator). */
  PIPE: 'PIPE',
  /** `||` (inline table cell separator). */
  DOUBLE_PIPE: 'DOUBLE_PIPE',
  /** `!` at line start (table header cell). */
  TABLE_HEADER_CELL: 'TABLE_HEADER_CELL',
  /** `!!` (inline table header cell separator). */
  DOUBLE_BANG: 'DOUBLE_BANG',

  // -- Bold / Italic --

  /**
   * Consecutive `'` characters (2 or more). The token's length encodes
   * the run: 2 = italic, 3 = bold, 5 = bold+italic, etc. Disambiguation
   * is deferred to the inline parser.
   */
  APOSTROPHE_RUN: 'APOSTROPHE_RUN',

  // -- Links --

  /** `[[` (wikilink / image / category open). */
  LINK_OPEN: 'LINK_OPEN',
  /** `]]` (wikilink / image / category close). */
  LINK_CLOSE: 'LINK_CLOSE',
  /** `[` (external link open). */
  EXT_LINK_OPEN: 'EXT_LINK_OPEN',
  /** `]` (external link close). */
  EXT_LINK_CLOSE: 'EXT_LINK_CLOSE',

  // -- Templates / arguments --

  /** `{{` (template / parser function open). */
  TEMPLATE_OPEN: 'TEMPLATE_OPEN',
  /** `}}` (template / parser function close). */
  TEMPLATE_CLOSE: 'TEMPLATE_CLOSE',
  /** `{{{` (argument / triple-brace parameter open). */
  ARGUMENT_OPEN: 'ARGUMENT_OPEN',
  /** `}}}` (argument / triple-brace parameter close). */
  ARGUMENT_CLOSE: 'ARGUMENT_CLOSE',

  // -- HTML / extension tags --

  /** `<` that opens an HTML or extension tag. */
  TAG_OPEN: 'TAG_OPEN',
  /** `>` that closes a tag opening. */
  TAG_CLOSE: 'TAG_CLOSE',
  /** `</` that opens a closing tag. */
  CLOSING_TAG_OPEN: 'CLOSING_TAG_OPEN',
  /** `/>` (self-closing tag end). */
  SELF_CLOSING_TAG_END: 'SELF_CLOSING_TAG_END',
  /** `<!--` (comment open). */
  COMMENT_OPEN: 'COMMENT_OPEN',
  /** `-->` (comment close). */
  COMMENT_CLOSE: 'COMMENT_CLOSE',

  // -- HTML entity --

  /** `&...;` HTML character entity. */
  HTML_ENTITY: 'HTML_ENTITY',

  // -- Special constructs --

  /** `~~~`, `~~~~`, or `~~~~~` (signature). */
  SIGNATURE: 'SIGNATURE',
  /** `__TOC__`, `__NOTOC__`, etc. (behavior switch). */
  BEHAVIOR_SWITCH: 'BEHAVIOR_SWITCH',
  /** Leading space at line start (preformatted line). */
  PREFORMATTED_MARKER: 'PREFORMATTED_MARKER',

  // -- Equals (non-heading context) --

  /** `=` not at line start/end (e.g., template argument separator). */
  EQUALS: 'EQUALS',

  // -- End of input --

  /** Signals end of the token stream. */
  EOF: 'EOF',
} as const;

/**
 * Union of all token type string literals.
 *
 * TypeScript derives this from the `TokenType` const object:
 * `typeof TokenType[keyof typeof TokenType]` extracts every value.
 * The result is `'TEXT' | 'NEWLINE' | 'HEADING_MARKER' | ...`, which
 * lets the compiler narrow `Token.type` in switch statements and
 * equality checks.
 */
export type TokenType = typeof TokenType[keyof typeof TokenType];

/**
 * Precomputed membership set for {@linkcode TokenType} string values.
 *
 * Why a `Set` instead of calling `Object.values(TokenType).includes()`
 * each time? `Object.values()` allocates a fresh array on every call,
 * and `.includes()` does a linear scan. Since `isToken()` is a hot-path
 * guard called by downstream consumers, we pay the one-time cost of
 * building a `Set` and get O(1) `.has()` lookups with zero allocation
 * afterward.
 */
const TOKEN_TYPE_SET: ReadonlySet<string> = new Set<string>(
  Object.values(TokenType),
);

/**
 * A single token produced by the tokenizer.
 *
 * Tokens carry start/end offsets into the {@linkcode TextSource}, not value
 * strings. This is a core performance discipline: it avoids per-token string
 * allocation and sidesteps V8's sliced-string retention risk (where a small
 * `string.slice()` can pin the entire parent string in memory).
 *
 * To get the text a token represents, call:
 * ```ts
 * import { slice } from './text_source.ts';
 * const value = slice(source, token.start, token.end);
 * ```
 *
 * Each yielded token is a fresh immutable object: the tokenizer never
 * reuses token objects across generator yields, so consumers can safely
 * hold references.
 */
export interface Token {
  /** Discriminant identifying the syntactic role of this token. */
  readonly type: TokenType;

  /** Inclusive start offset in UTF-16 code units into the `TextSource`. */
  readonly start: number;

  /** Exclusive end offset in UTF-16 code units into the `TextSource`. */
  readonly end: number;
}

/**
 * Type guard: check whether an unknown value is a valid {@linkcode Token}.
 *
 * Tests for a non-null object with `type`, `start`, and `end` fields where
 * `type` is a known {@linkcode TokenType} string. This is useful at system
 * boundaries (e.g., deserializing tokens from JSON, filtering mixed arrays)
 * where the shape is not statically guaranteed.
 *
 * Uses the precomputed {@linkcode TOKEN_TYPE_SET} for O(1) membership
 * checks rather than scanning the `TokenType` values on every call.
 *
 * @example Filtering tokens from a mixed array
 * ```ts
 * import { isToken, TokenType } from './token.ts';
 *
 * const things = [
 *   { type: TokenType.TEXT, start: 0, end: 5 },
 *   { kind: 'other' },
 *   null,
 * ];
 * const tokens = things.filter(isToken);
 * // tokens.length === 1
 * ```
 *
 * @example Narrowing an unknown value
 * ```ts
 * import { isToken } from './token.ts';
 *
 * function process(val: unknown) {
 *   if (isToken(val)) {
 *     val.start; // number (narrowed)
 *   }
 * }
 * ```
 */
export function isToken(value: unknown): value is Token {
  // Reject primitives and null early — they can't be tokens.
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === 'string' &&
    typeof obj.start === 'number' &&
    typeof obj.end === 'number' &&
    // O(1) lookup against the precomputed set of valid token type strings.
    TOKEN_TYPE_SET.has(obj.type)
  );
}
