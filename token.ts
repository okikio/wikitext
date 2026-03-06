/**
 * Token vocabulary and token shape for the raw scanner layer.
 *
 * This file defines the smallest structural units the tokenizer can emit.
 * A token is not a parsed wiki node. It is a labeled span of source text.
 * Later stages decide what those spans mean in context.
 *
 * The tokenizer walks a `TextSource` and emits `Token` objects whose `type`
 * says what kind of character sequence was recognized and whose `start` and
 * `end` fields point back into the original source. Consumers recover text
 * only when they actually need it.
 *
 * That design keeps the hot path simple:
 *
 * - the scanner can work with offsets instead of allocating a string for
 *   every token
 * - downstream code can slice lazily
 * - small token views do not accidentally keep large source strings alive
 *
 * The key invariant is simple: token ranges tile the input from start to end.
 * There are no gaps and no overlaps. Adjacent tokens meet exactly at their
 * shared boundary.
 *
 * For the input `"== Hi =="`, the stream can be visualized like this:
 *
 * ```
 * source:  =  =     H  i     =  =
 * index :  0  1  2  3  4  5  6  7  8
 *
 * range :  [0,2) [2,3) [3,5) [5,6) [6,8) [8,8)
 * token :  ?      WHITESPACE TEXT  WHITESPACE ?      EOF
 * ```
 *
 * The exact token kind for the `==` runs depends on the tokenizer's heading
 * rules. If the scanner distinguishes opening and closing heading markers,
 * those positions would be `HEADING_MARKER` and `HEADING_MARKER_CLOSE`.
 * If it does not, they would be `EQUALS`. 
 *
 * This file only defines the vocabulary and the shared token contract.
 * Block structure, inline structure, and semantic classification happen in
 * later stages of the pipeline.
 *
 * @module
 */

/**
 * Constant map of token kinds emitted by the tokenizer.
 *
 * Each value names one class of source span the scanner can recognize.
 * Some token kinds are purely lexical, such as `TEXT`, `NEWLINE`, and
 * `WHITESPACE`. Others mark delimiter runs such as `[[`, `{{`, `{|`,
 * or apostrophe runs used later for bold and italic parsing.
 *
 * `TokenType` is a plain `as const` object instead of a TypeScript `enum`.
 * That keeps the runtime shape simple and standard JavaScript friendly while
 * still giving TypeScript a literal-string union for narrowing and exhaustive
 * switching.
 *
 * In practice that means:
 *
 * - debugger output stays readable because token types are strings
 * - logs show meaningful names instead of numeric enum members
 * - bundlers do not need to preserve enum machinery
 * 
 * Example shape:
 *
 * ```ts
 * const tok = { type: TokenType.TEXT, start: 5, end: 9 };
 * ```
 *
 * The token does not store its own string value. Consumers recover text from
 * the source with `slice(source, tok.start, tok.end)`.
 *
 * Keep one boundary in mind while reading these names: they describe what the
 * scanner saw, not the full meaning of the construct. For example, `[[` may
 * later become a wikilink, a category link, or a file link depending on the
 * surrounding parse rules.
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

  /** One or more `=` characters recognized as a heading opener. */
  HEADING_MARKER: 'HEADING_MARKER',
  /** One or more `=` characters recognized as a heading closer. */
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
   * 
   * 
   * Consecutive apostrophes, usually length 2 or greater.
   *
   * The tokenizer preserves the raw run length and leaves interpretation to the
   * inline parser. That later stage decides whether the run participates in
   * italic, bold, bold+italic, or should stay literal under recovery rules.
   * 
   * Standard usage is: 2 = italic, 3 = bold, 5 = bold+italic, etc.
   */
  APOSTROPHE_RUN: 'APOSTROPHE_RUN',

  // -- Links --

  /** `[[` delimiter. Later parsing decides whether this is a wikilink, file link, or category link. */
  LINK_OPEN: 'LINK_OPEN',
  /** `]]` delimiter for double-bracket links. */
  LINK_CLOSE: 'LINK_CLOSE',
  /** `[` delimiter for bracketed external-link syntax. */
  EXT_LINK_OPEN: 'EXT_LINK_OPEN',
  /** `]` delimiter for bracketed external-link syntax. */
  EXT_LINK_CLOSE: 'EXT_LINK_CLOSE',

  // -- Templates / arguments --

  /** `{{` delimiter used by templates and parser-function-like constructs. */
  TEMPLATE_OPEN: 'TEMPLATE_OPEN',
  /** `}}` closing delimiter for double-brace constructs. */
  TEMPLATE_CLOSE: 'TEMPLATE_CLOSE',
  /** `{{{` opening delimiter for triple-brace argument syntax. */
  ARGUMENT_OPEN: 'ARGUMENT_OPEN',
  /** `}}}` closing delimiter for triple-brace argument syntax. */
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
  /** A complete HTML character reference such as `&amp;`, `&#123;`, or `&#x1F;`. */
  HTML_ENTITY: 'HTML_ENTITY',

  // -- Special constructs --

  /** `~~~`, `~~~~`, or `~~~~~` (signature). */
  SIGNATURE: 'SIGNATURE',
  /** `__TOC__`, `__NOTOC__`, etc. (behavior switch). */
  BEHAVIOR_SWITCH: 'BEHAVIOR_SWITCH',
  /** Leading space at line start (preformatted line). */
  PREFORMATTED_MARKER: 'PREFORMATTED_MARKER',

  // -- Equals (non-heading context) --

  /** `=` characters not classified as heading markers at this scanner position. */
  EQUALS: 'EQUALS',

  // -- End of input --

  /** Signals end of the token stream. */
  EOF: 'EOF',
} as const;

/**
 * Union of all token type string literals.
 *
 * Derived from `TokenType`, so `Token["type"]` narrows cleanly in equality
 * checks and `switch` statements.
 */
export type TokenType = typeof TokenType[keyof typeof TokenType];

/**
 * Membership set for fast runtime validation of token type strings.
 *
 * Built once so `isToken()` can avoid repeated array allocation and linear
 * scans over `Object.values(TokenType)`.
 */
const TOKEN_TYPE_SET: ReadonlySet<string> = new Set<string>(
  Object.values(TokenType),
);

/**
 * A single scanner token.
 *
 * A token identifies a span of source text and labels it with a token kind.
 * It does not store a copied string value. Consumers recover text from the
 * original `{@link TextSource}` when needed.
 *
 * This keeps the scanner cheap and makes token streams safe to hold onto even
 * when the input is large.
 *
 * Another important invariant follows from the tokenizer contract: token
 * ranges tile the input. For non-EOF tokens, the concatenation of all
 * `slice(source, token.start, token.end)` values reconstructs the original
 * source exactly.
 */
export interface Token {
  /** Token kind from the shared `TokenType` vocabulary. */
  readonly type: TokenType;

  /** Inclusive UTF-16 start offset into the source. */
  readonly start: number;

  /** Exclusive UTF-16 end offset into the source. */
  readonly end: number;
}

/**
 * Returns `true` when a value has the runtime shape of a `Token`.
 *
 * This is mainly useful at system boundaries where static typing cannot help,
 * such as JSON input, message passing, or mixed collections.
 *
 * The check is structural:
 *
 * - object and not `null`
 * - `type` is a known token type string
 * - `start` and `end` are numbers
 *
 * It does not validate semantic invariants such as `start <= end` or whether
 * the range is valid for a particular source.
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
