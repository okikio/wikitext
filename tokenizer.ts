/**
 * Generator-based tokenizer for raw wikitext source.
 *
 * This is the first real parsing stage. Its job is simple: walk through the
 * source from left to right and mark the important character runs it sees.
 * Think of it as turning one long source string into labeled slices such as:
 *
 * - plain text
 * - newline
 * - `[[`
 * - `{{`
 * - `|`
 * - heading marker runs like `==`
 *
 * It does not decide the full meaning of those pieces yet. For example,
 * spotting `[[` is not the same as deciding whether the final construct is a
 * normal wikilink, a category link, or a file link. This stage only marks the
 * raw source shape. Parser literature often calls this the lexical stage, but
 * the practical meaning here is just "recognize the text patterns first, then
 * let later stages decide what they mean together".
 *
 * The tokenizer runs in one pass and yields tokens lazily:
 *
 * ```
 * TextSource -> tokenize() -> Token stream
 * ```
 *
 * The hottest operation in this whole file is `source.charCodeAt(i)`. The
 * tokenizer calls it over and over while scanning. Using numeric character
 * codes lets the hot loop compare small numbers instead of creating temporary
 * one-character strings.
 *
 * The scanner also keeps one small piece of context: whether it is at the
 * start of a line. Wikitext uses the same characters differently depending on
 * where they appear. For example:
 *
 * - `=` at the start of a line can begin a heading
 * - `*` at the start of a line can begin a bullet list item
 * - the same characters in the middle of normal text often mean something else
 *   or just stay text
 *
 * A large chunk of the input is usually ordinary prose. So the fast path is
 * not the special markup. The fast path is "keep absorbing plain text until we
 * hit something that could start markup".
 *
 * Every code unit in the source belongs to exactly one token range. In plain
 * English, the token ranges cover the whole input with no holes and no overlap.
 * If one token ends at offset 12, the next one starts at 12.
 *
 * For `Hello [[world]]`, the stream tiles the input like this:
 *
 * ```
 * source: H  e  l  l  o     [  [  w  o  r  l  d  ]  ]
 * index : 0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
 * token : [0,5) TEXT
 *         [5,6) WHITESPACE
 *         [6,8) LINK_OPEN
 *         [8,13) TEXT
 *         [13,15) LINK_CLOSE
 * ```
 *
 * The tokenizer never throws. Even malformed input still produces a full token
 * stream ending in EOF.
 *
 * @example Tokenizing a simple heading
 * ```ts
 * import { tokenize } from './tokenizer.ts';
 *
 * const tokens = Array.from(tokenize('== Hi =='));
 * ```
 *
 * @example Tokenizing a wikilink
 * ```ts
 * import { tokenize } from './tokenizer.ts';
 *
 * const tokens = Array.from(tokenize('[[Page|label]]'));
 * // LINK_OPEN, TEXT("Page"), PIPE, TEXT("label"), LINK_CLOSE, EOF
 * ```
 *
 * @module
 */

import type { TextSource } from './text_source.ts';
import type { Token } from './token.ts';
import { TokenType } from './token.ts';

// ---------------------------------------------------------------------------
// Character code constants
//
// The tokenizer's inner loop compares numeric character codes, not strings.
// These constants name each code point the scanner cares about. Using named
// constants instead of inline hex literals makes the switch/if chains
// readable without sacrificing performance (V8 inlines them).
// ---------------------------------------------------------------------------

/** @internal */ const CC_LF = 0x0a;         // '\n'
/** @internal */ const CC_CR = 0x0d;         // '\r'
/** @internal */ const CC_SPACE = 0x20;      // ' '
/** @internal */ const CC_TAB = 0x09;        // '\t'
/** @internal */ const CC_BANG = 0x21;       // '!'
/** @internal */ const CC_HASH = 0x23;       // '#'
/** @internal */ const CC_AMP = 0x26;        // '&'
/** @internal */ const CC_APOSTROPHE = 0x27; // "'"
/** @internal */ const CC_ASTERISK = 0x2a;   // '*'
/** @internal */ const CC_DASH = 0x2d;       // '-'
/** @internal */ const CC_COLON = 0x3a;      // ':'
/** @internal */ const CC_SEMICOLON = 0x3b;  // ';'
/** @internal */ const CC_LT = 0x3c;        // '<'
/** @internal */ const CC_EQUALS = 0x3d;     // '='
/** @internal */ const CC_GT = 0x3e;        // '>'
/** @internal */ const CC_OPEN_BRACKET = 0x5b;  // '['
/** @internal */ const CC_CLOSE_BRACKET = 0x5d; // ']'
/** @internal */ const CC_UNDERSCORE = 0x5f;    // '_'
/** @internal */ const CC_OPEN_BRACE = 0x7b;    // '{'
/** @internal */ const CC_PIPE = 0x7c;       // '|'
/** @internal */ const CC_CLOSE_BRACE = 0x7d;   // '}'
/** @internal */ const CC_TILDE = 0x7e;      // '~'
/** @internal */ const CC_SLASH = 0x2f;      // '/'

// ---------------------------------------------------------------------------
// Delimiter lookup table
//
// A precomputed 128-entry table where entry `c` is 1 if character code `c`
// could start a wikitext delimiter, 0 otherwise. Used by the TEXT
// accumulation loop to decide when to stop consuming plain text.
//
// This replaces a 23-case switch statement. The advantage:
// - Single array access instead of a jump table
// - Characters >= 128 (all non-ASCII: CJK, emoji, RTL) skip the lookup
//   entirely via a single comparison (`c < 128`), making prose-heavy
//   articles faster to scan.
// ---------------------------------------------------------------------------

/**
 * Return whether a character code is a wikitext delimiter that can start
 * a recognized token. Used both as a readable predicate and to populate
 * the {@linkcode DELIMITER} lookup table.
 */
function isDelimiterChar(c: number): boolean {
  switch (c) {
    case CC_LF:
    case CC_CR:
    case CC_SPACE:
    case CC_TAB:
    case CC_BANG:
    case CC_HASH:
    case CC_AMP:
    case CC_APOSTROPHE:
    case CC_ASTERISK:
    case CC_DASH:
    case CC_COLON:
    case CC_SEMICOLON:
    case CC_LT:
    case CC_EQUALS:
    case CC_GT:
    case CC_OPEN_BRACKET:
    case CC_CLOSE_BRACKET:
    case CC_UNDERSCORE:
    case CC_OPEN_BRACE:
    case CC_PIPE:
    case CC_CLOSE_BRACE:
    case CC_TILDE:
    case CC_SLASH:
      return true;
    default:
      return false;
  }
}

const DELIMITER = Uint8Array.from({ length: 128 }, (_, c) =>
  isDelimiterChar(c) ? 1 : 0,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a token object. Centralizes token construction so the shape is
 * consistent and monomorphic (V8 produces a single hidden class).
 */
function tok(type: TokenType, start: number, end: number): Token {
  return { type, start, end };
}

/**
 * Check whether a character code is an ASCII letter (a-z, A-Z).
 */
function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * Check whether a character code is an ASCII digit (0-9).
 */
function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Check whether a character code is an ASCII alphanumeric character.
 */
function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code);
}



// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Scan a {@linkcode TextSource} and yield one {@linkcode Token} per recognized
 * syntactic unit.
 *
 * The generator performs a single left-to-right pass over the source,
 * tracking one boolean (`lineStart`) alongside the scan position `i`.
 * `lineStart` is `true` at position 0 and after every newline. This flag
 * determines how ambiguous characters are classified: `=` at line start
 * is a heading marker, but mid-line it is a plain equals sign (used in
 * template argument `name=value` syntax).
 *
 * The algorithm has two phases per character. Both exist to keep the
 * common case fast while still recognizing all wikitext delimiters:
 *
 * 1. **Fast text gate**: if the character is non-ASCII *or* is not in the
 *    DELIMITER lookup table, fall into a tight inner loop that absorbs
 *    consecutive non-delimiter characters into a single TEXT token.
 *    This handles the majority of input (plain prose) in bulk.
 *
 * 2. **Delimiter dispatch**: for the ~23 delimiter characters, a `switch`
 *    statement selects the appropriate token or multi-character sequence.
 *    Each case consumes one logical unit (e.g., `<!--` for comment open,
 *    `{{{` for argument open) and yields the corresponding token.
 *
 * Concrete walk-through for `"== Hi ==\n* item"` -- showing how
 * `lineStart` drives the heading-vs-equals and bullet-vs-text decisions:
 *
 * ```
 * pos  char  lineStart  action
 * ---  ----  ---------  -------------------------------------------
 *   0  '='   true       absorb run of '=' → HEADING_MARKER [0,2)
 *   2  ' '   false      absorb spaces     → WHITESPACE [2,3)
 *   3  'H'   false      fast text path    → TEXT [3,5)
 *   5  ' '   false      absorb spaces     → WHITESPACE [5,6)
 *   6  '='   false      absorb run of '=' → EQUALS [6,8)
 *   8  '\n'  false      newline           → NEWLINE [8,9), lineStart=true
 *   9  '*'   true       bullet marker     → BULLET [9,10)
 *  10  ' '   true       preformatted?     → PREFORMATTED_MARKER [10,11)
 *  11  'i'   false      fast text path    → TEXT [11,15)
 *  15  EOF              end of input      → EOF [15,15)
 * ```
 *
 * The final token is always `EOF` with `start === end === source.length`.
 *
 * Invariants maintained:
 * - Token ranges tile the input: `tokens[i].end === tokens[i+1].start`
 *   (except EOF which has zero width).
 * - Every code unit in `[0, source.length)` falls within exactly one
 *   non-EOF token's `[start, end)` range.
 * - The generator never throws, regardless of input content.
 *
 * @param source - The text to tokenize. A plain `string` works.
 *
 * @example Collecting all tokens
 * ```ts
 * import { tokenize } from './tokenizer.ts';
 *
 * const all = Array.from(tokenize('Hello [[world]]'));
 * ```
 *
 * @example Lazy consumption
 * ```ts
 * import { tokenize } from './tokenizer.ts';
 * import { TokenType } from './token.ts';
 *
 * for (const token of tokenize('== Heading ==\nBody text')) {
 *   if (token.type === TokenType.EOF) break;
 *   // process each token lazily
 * }
 * ```
 */
export function* tokenize(source: TextSource): Generator<Token> {
  const len = source.length;
  let i = 0;
  // This single flag carries the tokenizer's line-sensitive context. Many
  // delimiters change meaning at line start, so keeping it explicit here makes
  // the hot loop easier to reason about during debugging.
  let lineStart = true;

  while (i < len) {
    const code = source.charCodeAt(i);

    // -----------------------------------------------------------------------
    // Fast path: ordinary text
    //
    // Most input is plain prose. This gate runs before any syntax checks.
    // If the character is non-ASCII (code >= 128: CJK, emoji, RTL, etc.)
    // or is ASCII but not in the DELIMITER lookup table, it cannot start
    // any wikitext syntax. Fall into a tight inner loop that accumulates
    // consecutive non-delimiter characters into one TEXT token.
    //
    // Example: "Hello world" at position 0
    //   Step 1: 'H' (code 72) → not a delimiter → enter loop
    //   Step 2: absorb 'e','l','l','o' → still not delimiters
    //   Step 3: ' ' (code 32) → IS a delimiter → stop
    //   → yield TEXT [0, 5) covering "Hello"
    //
    // This path handles ~60-80% of characters in a typical article.
    // The `code >= 128` check before the table lookup means non-ASCII
    // text (Chinese, Japanese, Arabic, emoji) never touches the table
    // at all, making CJK-heavy articles very fast.
    // -----------------------------------------------------------------------
    if (code >= 128 || !DELIMITER[code]) {
      const start = i;
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c < 128 && DELIMITER[c]) break;
        i++;
      }
      lineStart = false;
      yield tok(TokenType.TEXT, start, i);
      continue;
    }

    // -----------------------------------------------------------------------
    // Delimiter dispatch
    //
    // When the fast text gate stops at a delimiter, this switch determines
    // which token to emit. Each case handles one delimiter character (or
    // family of multi-character sequences starting with that character)
    // and yields the token that tells the block/inline parsers what
    // structure to build.
    // -----------------------------------------------------------------------
    switch (code) {

      // --- Newline: \n, \r\n, or bare \r ---
      //
      // Newlines are structurally significant in wikitext: they separate
      // block elements and reset `lineStart` to true, enabling line-start
      // markers on the next line. Windows-style \r\n is treated as a
      // single newline token (2 code units wide).
      //
      // Example: "abc\r\ndef"
      //   pos 3: \r detected → peek ahead, pos 4 is \n → NEWLINE [3,5)
      //   lineStart becomes true for the 'd' at position 5
      //
      // Example: "abc\ndef"
      //   pos 3: \n detected → NEWLINE [3,4), lineStart=true
      case CC_LF:
      case CC_CR: {
        const start = i;
        if (code === CC_CR && i + 1 < len && source.charCodeAt(i + 1) === CC_LF) {
          i += 2;
        } else {
          i += 1;
        }
        yield tok(TokenType.NEWLINE, start, i);
        lineStart = true;
        continue;
      }

      // --- Space ---
      //
      // A space at the start of a line triggers preformatted mode in
      // MediaWiki (rendered as <pre>). Mid-line spaces are whitespace.
      //
      // Example: " code here" (space at line start)
      //   pos 0: space + lineStart → PREFORMATTED_MARKER [0,1)
      //   The text "code here" follows as normal tokens.
      //
      // Example: "hello   world" (spaces mid-line)
      //   pos 5: space, not lineStart → absorb all spaces/tabs
      //   → WHITESPACE [5,8) covering "   "
      case CC_SPACE: {
        if (lineStart) {
          yield tok(TokenType.PREFORMATTED_MARKER, i, i + 1);
          i += 1;
          lineStart = false;
          continue;
        }
        const start = i;
        while (i < len) {
          const c = source.charCodeAt(i);
          if (c !== CC_SPACE && c !== CC_TAB) break;
          i++;
        }
        yield tok(TokenType.WHITESPACE, start, i);
        continue;
      }

      // --- Tab ---
      //
      // Tabs are always whitespace (never preformatted markers). Like
      // spaces, consecutive tabs and spaces are merged into one
      // WHITESPACE token.
      case CC_TAB: {
        const start = i;
        while (i < len) {
          const c = source.charCodeAt(i);
          if (c !== CC_SPACE && c !== CC_TAB) break;
          i++;
        }
        // Tabs never preserve line-start meaning. That is different from list
        // markers, where the next marker on the same line can still be part of
        // the structural prefix.
        lineStart = false;
        yield tok(TokenType.WHITESPACE, start, i);
        continue;
      }

      // --- Equals ---
      //
      // Equals signs serve dual purpose depending on position:
      // - At line start: heading markers. The run length determines the
      //   heading level (== is h2, === is h3, up to ======).
      // - Mid-line: generic EQUALS (used for template arg separators
      //   like `name=value`, or closing heading markers).
      //
      // Note: the block parser later reclassifies trailing EQUALS as
      // HEADING_MARKER_CLOSE when they close a heading. The tokenizer
      // cannot distinguish `== Hi ==` close markers from `{{x|a==b}}`
      // equality signs without block context.
      //
      // Example: "== Title ==" (line start)
      //   pos 0: '==' at lineStart → HEADING_MARKER [0,2)
      //   pos 9: '==' not lineStart → EQUALS [9,11)
      //
      // Example: "{{Tmpl|key=val}}"
      //   pos 10: '=' not lineStart → EQUALS [10,11)
      case CC_EQUALS: {
        const wasLineStart = lineStart;
        const start = i;
        while (i < len && source.charCodeAt(i) === CC_EQUALS) i++;
        // Once the run is consumed, the rest of the line is no longer at a
        // line boundary, regardless of whether this became HEADING_MARKER or
        // plain EQUALS.
        lineStart = false;
        yield tok(wasLineStart ? TokenType.HEADING_MARKER : TokenType.EQUALS, start, i);
        continue;
      }

      // --- Asterisk (bullet list marker at line start) ---
      //
      // In wikitext, `*` at line start introduces a bullet list item.
      // Multiple markers stack for nesting: `**` is a nested bullet.
      // Mid-line `*` has no special meaning (plain text).
      //
      // lineStart stays true after emitting BULLET so that subsequent
      // markers on the same line are also recognized as list markers.
      // This allows mixed stacking like `*#` (bullet containing ordered).
      //
      // Example: "** nested item"
      //   pos 0: '*' at lineStart → BULLET [0,1), lineStart stays true
      //   pos 1: '*' at lineStart → BULLET [1,2), lineStart stays true
      //   pos 2: ' ' at lineStart → PREFORMATTED_MARKER [2,3)
      //   pos 3: 'n' → TEXT "nested item"
      case CC_ASTERISK: {
        if (lineStart) {
          yield tok(TokenType.BULLET, i, i + 1);
          i += 1;
          // Stay lineStart=true so stacked markers (*#:;) are recognized
          continue;
        }
        // Mid-line '*' is plain text. It is in the DELIMITER table
        // because it matters at line start.
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Hash (ordered list marker at line start) ---
      //
      // `#` at line start = ordered list. `##` = nested.
      // Mid-line `#` is text (e.g., inside parser function names).
      // Same lineStart-preservation logic as BULLET.
      case CC_HASH: {
        if (lineStart) {
          yield tok(TokenType.HASH, i, i + 1);
          i += 1;
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Colon (definition list / indent at line start) ---
      //
      // `:` at line start = definition description or indentation.
      // Common on talk pages for threaded replies: each `:` adds
      // one level of indent. Mid-line `:` is text.
      //
      // Example: ":: reply" → COLON, COLON, then the rest.
      case CC_COLON: {
        if (lineStart) {
          yield tok(TokenType.COLON, i, i + 1);
          i += 1;
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Semicolon (definition term at line start) ---
      //
      // `;` at line start = definition term (the "word being defined"
      // in a definition list, rendered as <dt>).
      case CC_SEMICOLON: {
        if (lineStart) {
          yield tok(TokenType.SEMICOLON, i, i + 1);
          i += 1;
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Dash (thematic break at line start) ---
      //
      // Four or more dashes at line start produce a horizontal rule
      // (<hr> in HTML). Fewer than four dashes are plain text.
      //
      // Example: "----" at line start → THEMATIC_BREAK [0,4)
      // Example: "---" at line start  → TEXT [0,3) (not enough dashes)
      // Example: "------" mid-line    → TEXT [n,n+1) per dash
      case CC_DASH: {
        if (lineStart) {
          const start = i;
          while (i < len && source.charCodeAt(i) === CC_DASH) i++;
          lineStart = false;
          if (i - start >= 4) {
            yield tok(TokenType.THEMATIC_BREAK, start, i);
          } else {
            yield tok(TokenType.TEXT, start, i);
          }
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Bang: table headers and inline header separators ---
      //
      // `!` at line start opens a table header cell. Inside a table,
      // `!!` mid-line separates consecutive header cells on one line.
      // Outside these contexts, `!` is plain text.
      //
      // Example (inside a table):
      //   "! Name !! Age"  (at line start, inside {|...|} table)
      //   pos 0: '!' at lineStart → TABLE_HEADER_CELL [0,1)
      //   pos 7: '!!' mid-line → DOUBLE_BANG [7,9)
      case CC_BANG: {
        if (lineStart) {
          yield tok(TokenType.TABLE_HEADER_CELL, i, i + 1);
          i += 1;
          lineStart = false;
          continue;
        }
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_BANG) {
          yield tok(TokenType.DOUBLE_BANG, i, i + 2);
          i += 2;
          lineStart = false;
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Less-than: comments and HTML/extension tags ---
      //
      // HTML and extension tags are how wikitext embeds structured content
      // (<ref>, <nowiki>, <gallery>) and comments. The tokenizer
      // distinguishes four cases so the block parser knows immediately
      // whether it is entering a comment, a closing tag, an opening tag,
      // or plain text.
      //
      // The four cases:
      //
      // 1. `<!--` opens a comment. The tokenizer scans forward for
      //    the matching `-->` close. If found, it yields three tokens:
      //    COMMENT_OPEN, TEXT (the comment content), COMMENT_CLOSE.
      //    If `-->` is never found (unclosed comment), everything
      //    after `<!--` becomes TEXT. This is the recovery behavior.
      //
      //    Example: "<!-- hidden -->visible"
      //      COMMENT_OPEN [0,4), TEXT [4,11) " hidden ",
      //      COMMENT_CLOSE [11,14), TEXT [14,21) "visible"
      //
      //    Example: "<!-- never closed" (recovery)
      //      COMMENT_OPEN [0,4), TEXT [4,17) " never closed"
      //
      // 2. `</` opens a closing tag (e.g., `</div>`).
      //    → CLOSING_TAG_OPEN [i,i+2)
      //
      // 3. `<` followed by a letter opens an HTML/extension tag
      //    (e.g., `<ref>`, `<div>`). Only the `<` itself is emitted;
      //    the tag name becomes TEXT tokens for the block parser.
      //    → TAG_OPEN [i,i+1)
      //
      // 4. Bare `<` (not followed by `!--`, `/`, or letter) is text.
      //    Example: "3 < 5" → the '<' is TEXT.
      case CC_LT: {
        // <!-- comment -->
        if (i + 3 < len &&
          source.charCodeAt(i + 1) === CC_BANG &&
          source.charCodeAt(i + 2) === CC_DASH &&
          source.charCodeAt(i + 3) === CC_DASH) {
          yield tok(TokenType.COMMENT_OPEN, i, i + 4);
          i += 4;
          const contentStart = i;
          let found = false;
          while (i < len) {
            if (source.charCodeAt(i) === CC_DASH &&
              i + 2 < len &&
              source.charCodeAt(i + 1) === CC_DASH &&
              source.charCodeAt(i + 2) === CC_GT) {
              if (i > contentStart) {
                yield tok(TokenType.TEXT, contentStart, i);
              }
              yield tok(TokenType.COMMENT_CLOSE, i, i + 3);
              i += 3;
              found = true;
              break;
            }
            i++;
          }
          // Recovery keeps the stream tiled when the comment never closes. The
          // caller can still see where comment syntax started, and the trailing
          // text is not lost.
          if (!found && i > contentStart) {
            yield tok(TokenType.TEXT, contentStart, i);
          }
          lineStart = false;
          continue;
        }
        // </ closing tag
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_SLASH) {
          yield tok(TokenType.CLOSING_TAG_OPEN, i, i + 2);
          i += 2;
          lineStart = false;
          continue;
        }
        // <tag opening tag
        if (i + 1 < len && isAsciiLetter(source.charCodeAt(i + 1))) {
          yield tok(TokenType.TAG_OPEN, i, i + 1);
          i += 1;
          lineStart = false;
          continue;
        }
        // Bare '<': plain text
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Greater-than: closes an HTML tag opening ---
      //
      // The `>` in `<div class="x">` or `<br>`. Always yields
      // TAG_CLOSE regardless of context; the block parser pairs it
      // with the earlier TAG_OPEN.
      case CC_GT: {
        yield tok(TokenType.TAG_CLOSE, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Slash: self-closing tag end '/>' ---
      //
      // `/>` ends a self-closing tag like `<br/>` or `<ref name="x"/>`.
      // A bare `/` not followed by `>` is plain text.
      case CC_SLASH: {
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_GT) {
          yield tok(TokenType.SELF_CLOSING_TAG_END, i, i + 2);
          i += 2;
          lineStart = false;
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Ampersand: HTML character entities ---
      //
      // HTML entities let wikitext include characters that would otherwise
      // be interpreted as markup (e.g., `&lt;` for `<`, `&amp;` for `&`).
      // The tokenizer recognizes well-formed entities so the AST can
      // represent them as HtmlEntity nodes rather than raw text.
      //
      // Three entity forms:
      //   &name;     → named entity    (e.g., &amp; &lt; &quot;)
      //   &#digits;  → decimal entity  (e.g., &#123;)
      //   &#xhex;    → hex entity      (e.g., &#x1F4A9;)
      //
      // The algorithm probes ahead from `&`:
      //   Step 1: is next char `#`? → numeric path
      //     Step 1a: is char after `#` an `x`/`X`? → hex path
      //       absorb hex digits, require trailing `;`
      //     Step 1b: otherwise → decimal path
      //       absorb decimal digits, require trailing `;`
      //   Step 2: is next char a letter? → named entity path
      //     absorb alphanumeric chars, require trailing `;`
      //   Step 3: if none matched → bare `&` is TEXT
      //
      // If the probe finds the right pattern but no `;`, the `&` falls
      // through to TEXT. This means `&notaentity` stays as text.
      //
      // Example: "&amp;" → HTML_ENTITY [0,5)
      // Example: "&#123;" → HTML_ENTITY [0,6)
      // Example: "&#x1F;" → HTML_ENTITY [0,6)
      // Example: "&oops"  → TEXT [0,1) (no semicolon)
      case CC_AMP: {
        const start = i;
        let j = i + 1;
        if (j < len) {
          const next = source.charCodeAt(j);
          // Numeric entity
          if (next === CC_HASH) {
            j++;
            if (j < len && (source.charCodeAt(j) === 0x78 || source.charCodeAt(j) === 0x58)) {
              // &#x hex
              j++;
              const hexStart = j;
              while (j < len && isHexDigit(source.charCodeAt(j))) j++;
              if (j > hexStart && j < len && source.charCodeAt(j) === CC_SEMICOLON) {
                j++;
                yield tok(TokenType.HTML_ENTITY, start, j);
                i = j;
                lineStart = false;
                continue;
              }
            } else {
              // &#decimal
              const decStart = j;
              while (j < len && isAsciiDigit(source.charCodeAt(j))) j++;
              if (j > decStart && j < len && source.charCodeAt(j) === CC_SEMICOLON) {
                j++;
                yield tok(TokenType.HTML_ENTITY, start, j);
                i = j;
                lineStart = false;
                continue;
              }
            }
          }
          // Named entity
          else if (isAsciiLetter(next)) {
            j++;
            while (j < len && isAsciiAlphanumeric(source.charCodeAt(j))) j++;
            if (j < len && source.charCodeAt(j) === CC_SEMICOLON) {
              j++;
              yield tok(TokenType.HTML_ENTITY, start, j);
              i = j;
              lineStart = false;
              continue;
            }
          }
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Open brace: table, template, and argument openers ---
      //
      // Braces introduce the most deeply nested structures in wikitext:
      // tables, templates, and template arguments. The tokenizer must
      // distinguish all three because they nest differently and the
      // block/inline parsers handle each one as a distinct construct.
      //
      // Three multi-character sequences start with `{`:
      //
      // 1. `{|` at line start opens a table.
      //    Example: "{| class='wikitable'" → TABLE_OPEN [0,2)
      //
      // 2. `{{{` opens a template argument (triple-brace parameter).
      //    Example: "{{{name|default}}}" → ARGUMENT_OPEN [0,3)
      //    Checked before `{{` because `{{{` starts with `{{`.
      //
      // 3. `{{` opens a template or parser function.
      //    Example: "{{Infobox|...}}" → TEMPLATE_OPEN [0,2)
      //
      // A lone `{` is plain text.
      case CC_OPEN_BRACE: {
        if (lineStart && i + 1 < len && source.charCodeAt(i + 1) === CC_PIPE) {
          yield tok(TokenType.TABLE_OPEN, i, i + 2);
          i += 2;
          lineStart = false;
          continue;
        }
        if (i + 2 < len &&
          source.charCodeAt(i + 1) === CC_OPEN_BRACE &&
          source.charCodeAt(i + 2) === CC_OPEN_BRACE) {
          yield tok(TokenType.ARGUMENT_OPEN, i, i + 3);
          i += 3;
          lineStart = false;
          continue;
        }
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_OPEN_BRACE) {
          yield tok(TokenType.TEMPLATE_OPEN, i, i + 2);
          i += 2;
          lineStart = false;
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Close brace: argument and template closers ---
      //
      // `}}}` closes a template argument. `}}` closes a template.
      // `}}}` is checked first because it starts with `}}`.
      // A lone `}` is plain text.
      //
      // Example: "{{{1|fallback}}}" → ... ARGUMENT_CLOSE [14,17)
      // Example: "{{T}}" → ... TEMPLATE_CLOSE [3,5)
      case CC_CLOSE_BRACE: {
        if (i + 2 < len &&
          source.charCodeAt(i + 1) === CC_CLOSE_BRACE &&
          source.charCodeAt(i + 2) === CC_CLOSE_BRACE) {
          yield tok(TokenType.ARGUMENT_CLOSE, i, i + 3);
          i += 3;
          lineStart = false;
          continue;
        }
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_CLOSE_BRACE) {
          yield tok(TokenType.TEMPLATE_CLOSE, i, i + 2);
          i += 2;
          lineStart = false;
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Open bracket: wikilinks and external links ---
      //
      // `[[` opens a wikilink (internal link, image, or category tag).
      // `[` alone opens an external link.
      //
      // Example: "[[Main Page|display]]" → LINK_OPEN [0,2)
      // Example: "[https://example.com text]" → EXT_LINK_OPEN [0,1)
      case CC_OPEN_BRACKET: {
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_OPEN_BRACKET) {
          yield tok(TokenType.LINK_OPEN, i, i + 2);
          i += 2;
        } else {
          // A single `[` only means "maybe external link" at this stage. The
          // inline parser validates the URL shape later.
          yield tok(TokenType.EXT_LINK_OPEN, i, i + 1);
          i += 1;
        }
        lineStart = false;
        continue;
      }

      // --- Close bracket: wikilinks and external links ---
      //
      // `]]` closes a wikilink. `]` alone closes an external link.
      case CC_CLOSE_BRACKET: {
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_CLOSE_BRACKET) {
          yield tok(TokenType.LINK_CLOSE, i, i + 2);
          i += 2;
        } else {
          yield tok(TokenType.EXT_LINK_CLOSE, i, i + 1);
          i += 1;
        }
        lineStart = false;
        continue;
      }

      // --- Pipe: table delimiters and cell separators ---
      //
      // The pipe `|` is the most context-dependent delimiter in wikitext.
      // Inside tables it controls row/cell/caption structure; inside
      // templates and links it separates arguments and display text.
      // The tokenizer emits distinct token types so that the block
      // parser can tell these roles apart.
      //
      // At line start (inside a table):
      //   `|}` closes the table          → TABLE_CLOSE [i,i+2)
      //   `|-` starts a new table row     → TABLE_ROW [i,i+2)
      //   `|+` starts a table caption     → TABLE_CAPTION [i,i+2)
      //   `|`  starts a table data cell   → PIPE [i,i+1)
      //
      // Mid-line:
      //   `||` separates inline cells     → DOUBLE_PIPE [i,i+2)
      //   `|`  separates template args,
      //        link display text, etc.    → PIPE [i,i+1)
      //
      // Example: "{|\n|-\n| cell1 || cell2\n|}"
      //   line 1: "{|" → TABLE_OPEN
      //   line 2: "|-" → TABLE_ROW
      //   line 3: "|" → PIPE, " cell1 " → tokens, "||" → DOUBLE_PIPE
      //   line 4: "|}" → TABLE_CLOSE
      case CC_PIPE: {
        if (lineStart) {
          if (i + 1 < len && source.charCodeAt(i + 1) === CC_CLOSE_BRACE) {
            yield tok(TokenType.TABLE_CLOSE, i, i + 2);
            i += 2;
            lineStart = false;
            continue;
          }
          if (i + 1 < len && source.charCodeAt(i + 1) === CC_DASH) {
            yield tok(TokenType.TABLE_ROW, i, i + 2);
            i += 2;
            lineStart = false;
            continue;
          }
          if (i + 1 < len && source.charCodeAt(i + 1) === 0x2b) {
            yield tok(TokenType.TABLE_CAPTION, i, i + 2);
            i += 2;
            lineStart = false;
            continue;
          }
          // Bare `|` at line start can begin a table data row, so it remains a
          // structural token even before the block parser has confirmed that we
          // are really inside a table.
          yield tok(TokenType.PIPE, i, i + 1);
          i += 1;
          lineStart = false;
          continue;
        }
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_PIPE) {
          yield tok(TokenType.DOUBLE_PIPE, i, i + 2);
          i += 2;
        } else {
          yield tok(TokenType.PIPE, i, i + 1);
          i += 1;
        }
        lineStart = false;
        continue;
      }

      // --- Apostrophe: bold and italic markers ---
      //
      // Bold/italic is the most common inline formatting in wikitext.
      // The tokenizer counts consecutive apostrophes and emits one
      // APOSTROPHE_RUN token. The inline parser later resolves whether
      // a given run opens/closes bold, italic, or both, using
      // MediaWiki's disambiguation algorithm.
      //
      // Consecutive apostrophes encode formatting:
      //   ''    (2) = italic toggle
      //   '''   (3) = bold toggle
      //   ''''  (4) = effectively bold + one literal '
      //   ''''' (5) = bold+italic toggle
      //
      // The tokenizer absorbs the run and emits APOSTROPHE_RUN for
      // runs of 2 or more. A single apostrophe is TEXT (it's a normal
      // punctuation character). The inline parser later determines the
      // exact bold/italic nesting using MediaWiki's disambiguation
      // algorithm.
      //
      // Example: "it's '''bold''' text"
      //   pos 2: single ' → TEXT [2,3)
      //   pos 4: ''' → APOSTROPHE_RUN [4,7)
      //   pos 11: ''' → APOSTROPHE_RUN [11,14)
      case CC_APOSTROPHE: {
        const start = i;
        while (i < len && source.charCodeAt(i) === CC_APOSTROPHE) i++;
        // Single apostrophes are overwhelmingly ordinary punctuation. Treating
        // only longer runs as structural keeps prose cheap and easier to debug.
        if (i - start >= 2) {
          yield tok(TokenType.APOSTROPHE_RUN, start, i);
        } else {
          yield tok(TokenType.TEXT, start, i);
        }
        lineStart = false;
        continue;
      }

      // --- Tilde: signature markers ---
      //
      // Tilde runs of exactly 3, 4, or 5 are signature markers (expanded
      // by MediaWiki's pre-save transform to user/timestamp text):
      //   ~~~   (3) = username
      //   ~~~~  (4) = username + timestamp
      //   ~~~~~ (5) = timestamp only
      //
      // Runs of 1-2 or 6+ tildes are plain text. The tokenizer absorbs
      // the full run, checks the length, and decides.
      //
      // Example: "Signed: ~~~~"
      //   pos 8: absorb 4 tildes → SIGNATURE [8,12)
      //
      // Example: "~~~~~~ not a sig"
      //   pos 0: absorb 6 tildes → TEXT [0,6)
      case CC_TILDE: {
        const start = i;
        while (i < len && source.charCodeAt(i) === CC_TILDE) i++;
        const runLen = i - start;
        if (runLen >= 3 && runLen <= 5) {
          yield tok(TokenType.SIGNATURE, start, i);
        } else {
          yield tok(TokenType.TEXT, start, i);
        }
        lineStart = false;
        continue;
      }

      // --- Underscore: behavior switches __WORD__ ---
      //
      // Behavior switches are double-underscore keywords that control
      // page-level rendering in MediaWiki (e.g., __TOC__, __NOTOC__,
      // __NOEDITSECTION__).
      //
      // The tokenizer recognizes the structural pattern `__LETTERS__`
      // (two underscores, one or more ASCII letters, two underscores)
      // and always emits BEHAVIOR_SWITCH. It does NOT check against a
      // known word list. Whether the word is valid for a given
      // MediaWiki installation is a consumer/profile concern.
      //
      // This matters because MediaWiki extensions can register new
      // behavior switches at runtime. A source parser cannot know the
      // full set without configuration.
      //
      // Algorithm:
      //   Step 1: check for two consecutive underscores __
      //   Step 2: scan forward absorbing ASCII letters (a-z, A-Z)
      //   Step 3: require at least one letter (j > i+2)
      //   Step 4: check for closing __ at position j
      //   Step 5: if all matched → BEHAVIOR_SWITCH; otherwise TEXT
      //
      // Example: "__TOC__"
      //   pos 0: __ detected, scan letters T,O,C → j=5
      //   pos 5: __ found at j → BEHAVIOR_SWITCH [0,7)
      //
      // Example: "__123__" (digits, not letters)
      //   pos 0: __ detected, scan finds '1' (not a letter) → j=2
      //   j == i+2 (no letters absorbed) → TEXT [0,2)
      //
      // Example: "____" (no letters between)
      //   pos 0: __ detected, j=2, scan finds '_' (not a letter)
      //   j == i+2 → TEXT [0,2), then TEXT [2,4)
      //
      // Example: "__CUSTOM__" (unknown but valid pattern)
      //   → BEHAVIOR_SWITCH [0,10) (tokenizer is structural)
      case CC_UNDERSCORE: {
        if (i + 1 < len && source.charCodeAt(i + 1) === CC_UNDERSCORE) {
          const start = i;
          let j = i + 2;
          while (j < len && isAsciiLetter(source.charCodeAt(j))) j++;
          if (j > i + 2 &&
            j + 1 < len &&
            source.charCodeAt(j) === CC_UNDERSCORE &&
            source.charCodeAt(j + 1) === CC_UNDERSCORE) {
            yield tok(TokenType.BEHAVIOR_SWITCH, start, j + 2);
            i = j + 2;
            lineStart = false;
            continue;
          }
          yield tok(TokenType.TEXT, i, i + 2);
          i += 2;
          lineStart = false;
          continue;
        }
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // --- Fallback: any delimiter char not handled above ---
      default: {
        yield tok(TokenType.TEXT, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }
    }
  }

  // Final EOF token: signals end of stream.
  yield tok(TokenType.EOF, len, len);
}



/**
 * Check whether a character code is a hexadecimal digit (0-9, a-f, A-F).
 */
function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x46) || // A-F
    (code >= 0x61 && code <= 0x66)    // a-f
  );
}
