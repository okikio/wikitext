/**
 * Generator-based tokenizer that scans a {@linkcode TextSource} and yields
 * offset-based {@linkcode Token} objects.
 *
 * The tokenizer is the lowest layer in the parser pipeline. It reads the
 * source character by character using `charCodeAt` (no string allocations
 * in the hot loop) and recognizes all wikitext markup delimiters defined
 * by the {@linkcode TokenType} vocabulary.
 *
 * ```
 * TextSource ──► tokenize() ──► Generator<Token>
 *                  │
 *                  │  charCodeAt inner loop
 *                  │  yields offset-based tokens
 *                  │  never throws
 *                  │
 *                  ▼
 *          block parser consumes tokens
 * ```
 *
 * Design constraints:
 *
 * - **Never throw**: any input produces a valid token stream ending in EOF.
 * - **Generator**: tokens are yielded lazily; callers pull on demand.
 * - **Offset-based**: tokens carry `start`/`end` UTF-16 offsets, not strings.
 * - **Fresh objects**: each yielded token is a new object (no reuse across yields).
 * - **Deterministic**: same input always produces the same token sequence.
 * - **Token coverage**: every code unit is covered by exactly one token's range.
 *   Adjacent token ranges tile the entire input with no gaps or overlaps.
 *
 * The tokenizer does not assign semantic meaning beyond identifying the
 * syntactic role of each character sequence. Disambiguation (e.g., whether
 * an `APOSTROPHE_RUN` is italic, bold, or both) is deferred to the inline
 * parser.
 *
 * @example Tokenizing a simple heading
 * ```ts
 * import { tokenize } from './tokenizer.ts';
 * import { TokenType } from './token.ts';
 *
 * const tokens = Array.from(tokenize('== Hi =='));
 * tokens[0]; // { type: 'HEADING_MARKER', start: 0, end: 2 }
 * tokens[1]; // { type: 'WHITESPACE', start: 2, end: 3 }
 * tokens[2]; // { type: 'TEXT', start: 3, end: 5 }
 * tokens[3]; // { type: 'WHITESPACE', start: 5, end: 6 }
 * tokens[4]; // { type: 'HEADING_MARKER_CLOSE', start: 6, end: 8 }
 * tokens[5]; // { type: 'EOF', start: 8, end: 8 }
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
// Known behavior-switch words
// ---------------------------------------------------------------------------

/**
 * Set of recognized behavior switch keywords (without the `__` delimiters).
 *
 * MediaWiki defines these as "double-underscore" magic words that toggle
 * page-level behaviors. The tokenizer recognizes the `__WORD__` pattern
 * and emits a BEHAVIOR_SWITCH token only when the word is in this set.
 * Unknown `__WORD__` patterns are emitted as plain text.
 */
const BEHAVIOR_SWITCHES: ReadonlySet<string> = new Set([
  'TOC',
  'NOTOC',
  'FORCETOC',
  'NOEDITSECTION',
  'NEWSECTIONLINK',
  'NONEWSECTIONLINK',
  'NOGALLERY',
  'HIDDENCAT',
  'NOCONTENTCONVERT',
  'NOCC',
  'NOTITLECONVERT',
  'NOTC',
  'START',
  'END',
  'INDEX',
  'NOINDEX',
  'STATICREDIRECT',
  'NOGLOBAL',
  'DISAMBIG',
]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Scan a {@linkcode TextSource} and yield one {@linkcode Token} per recognized
 * syntactic unit.
 *
 * The generator performs a single left-to-right pass. It tracks whether the
 * current position is at line start to distinguish line-start-only markup
 * (headings, lists, tables, thematic breaks, preformatted markers) from
 * inline markup (links, templates, bold/italic).
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
  let lineStart = true;

  while (i < len) {
    const code = source.charCodeAt(i);

    // -----------------------------------------------------------------------
    // Newline: \n, \r\n, or bare \r
    // -----------------------------------------------------------------------
    if (code === CC_LF || code === CC_CR) {
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

    // === Line-start-only markup ===
    // These tokens are only recognized when `lineStart` is true.

    if (lineStart) {
      // Space at line start: preformatted marker
      if (code === CC_SPACE) {
        yield tok(TokenType.PREFORMATTED_MARKER, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // Heading: one or more '=' at line start
      if (code === CC_EQUALS) {
        const start = i;
        while (i < len && source.charCodeAt(i) === CC_EQUALS) i++;
        yield tok(TokenType.HEADING_MARKER, start, i);
        lineStart = false;
        continue;
      }

      // Bullet list: '*' at line start (may stack)
      if (code === CC_ASTERISK) {
        yield tok(TokenType.BULLET, i, i + 1);
        i += 1;
        // Stay lineStart=true so stacked markers (*#:;) are recognized
        continue;
      }

      // Ordered list: '#' at line start (may stack)
      if (code === CC_HASH) {
        yield tok(TokenType.HASH, i, i + 1);
        i += 1;
        continue;
      }

      // Definition list: ':' at line start
      if (code === CC_COLON) {
        yield tok(TokenType.COLON, i, i + 1);
        i += 1;
        continue;
      }

      // Definition term: ';' at line start
      if (code === CC_SEMICOLON) {
        yield tok(TokenType.SEMICOLON, i, i + 1);
        i += 1;
        continue;
      }

      // Table open: '{|' at line start
      if (code === CC_OPEN_BRACE && i + 1 < len && source.charCodeAt(i + 1) === CC_PIPE) {
        yield tok(TokenType.TABLE_OPEN, i, i + 2);
        i += 2;
        lineStart = false;
        continue;
      }

      // Table close: '|}' at line start
      if (code === CC_PIPE && i + 1 < len && source.charCodeAt(i + 1) === CC_CLOSE_BRACE) {
        yield tok(TokenType.TABLE_CLOSE, i, i + 2);
        i += 2;
        lineStart = false;
        continue;
      }

      // Table row: '|-' at line start
      if (code === CC_PIPE && i + 1 < len && source.charCodeAt(i + 1) === CC_DASH) {
        yield tok(TokenType.TABLE_ROW, i, i + 2);
        i += 2;
        lineStart = false;
        continue;
      }

      // Table caption: '|+' at line start
      if (code === CC_PIPE && i + 1 < len && source.charCodeAt(i + 1) === 0x2b) {
        yield tok(TokenType.TABLE_CAPTION, i, i + 2);
        i += 2;
        lineStart = false;
        continue;
      }

      // Table header cell: '!' at line start
      if (code === CC_BANG) {
        yield tok(TokenType.TABLE_HEADER_CELL, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // Table cell: '|' at line start (single pipe, not matched above)
      if (code === CC_PIPE) {
        yield tok(TokenType.PIPE, i, i + 1);
        i += 1;
        lineStart = false;
        continue;
      }

      // Thematic break: '----' (4+ dashes) at line start
      if (code === CC_DASH) {
        const start = i;
        while (i < len && source.charCodeAt(i) === CC_DASH) i++;
        if (i - start >= 4) {
          yield tok(TokenType.THEMATIC_BREAK, start, i);
        } else {
          // Fewer than 4 dashes: plain text
          yield tok(TokenType.TEXT, start, i);
        }
        lineStart = false;
        continue;
      }
    }

    // After any non-newline, non-line-start-marker token, we are no
    // longer at line start.
    lineStart = false;

    // -----------------------------------------------------------------------
    // Whitespace: spaces and tabs (not at line start)
    // -----------------------------------------------------------------------
    if (code === CC_SPACE || code === CC_TAB) {
      const start = i;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c !== CC_SPACE && c !== CC_TAB) break;
        i++;
      }
      yield tok(TokenType.WHITESPACE, start, i);
      continue;
    }

    // -----------------------------------------------------------------------
    // Comment: <!-- ... -->
    //
    // Must check before generic '<' handling. The scanner looks for the
    // 4-char sequence '<!--' and then searches for '-->'. If the closing
    // sequence is missing, the comment extends to end of input (recovery).
    // -----------------------------------------------------------------------
    if (code === CC_LT &&
      i + 3 < len &&
      source.charCodeAt(i + 1) === CC_BANG &&
      source.charCodeAt(i + 2) === CC_DASH &&
      source.charCodeAt(i + 3) === CC_DASH) {
      yield tok(TokenType.COMMENT_OPEN, i, i + 4);
      i += 4;
      // Scan for '-->'
      const contentStart = i;
      let found = false;
      while (i < len) {
        if (source.charCodeAt(i) === CC_DASH &&
          i + 2 < len &&
          source.charCodeAt(i + 1) === CC_DASH &&
          source.charCodeAt(i + 2) === CC_GT) {
          // Emit comment body as TEXT if non-empty
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
      // Unclosed comment: emit remaining as TEXT (recovery)
      if (!found && i > contentStart) {
        yield tok(TokenType.TEXT, contentStart, i);
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // HTML tag-like: <tag>, </tag>, <tag />, but not comments
    //
    // We recognize:
    //   '</'  → CLOSING_TAG_OPEN
    //   '<'   → TAG_OPEN  (if followed by letter)
    //   '/>'  → SELF_CLOSING_TAG_END
    //   '>'   → TAG_CLOSE
    // -----------------------------------------------------------------------
    if (code === CC_LT) {
      // '</': closing tag open
      if (i + 1 < len && source.charCodeAt(i + 1) === CC_SLASH) {
        yield tok(TokenType.CLOSING_TAG_OPEN, i, i + 2);
        i += 2;
        continue;
      }
      // '<' followed by letter: tag open
      if (i + 1 < len && isAsciiLetter(source.charCodeAt(i + 1))) {
        yield tok(TokenType.TAG_OPEN, i, i + 1);
        i += 1;
        continue;
      }
      // Bare '<': plain text
      yield tok(TokenType.TEXT, i, i + 1);
      i += 1;
      continue;
    }

    // '/>' self-closing tag end
    if (code === CC_SLASH && i + 1 < len && source.charCodeAt(i + 1) === CC_GT) {
      yield tok(TokenType.SELF_CLOSING_TAG_END, i, i + 2);
      i += 2;
      continue;
    }

    // '>' tag close
    if (code === CC_GT) {
      yield tok(TokenType.TAG_CLOSE, i, i + 1);
      i += 1;
      continue;
    }

    // -----------------------------------------------------------------------
    // HTML entity: &...;
    //
    // Recognize patterns: &name; or &#digits; or &#xhex;
    // If the pattern doesn't close with ';' within a reasonable span,
    // emit the '&' as TEXT.
    // -----------------------------------------------------------------------
    if (code === CC_AMP) {
      const start = i;
      let j = i + 1;
      // Named entity: &[a-zA-Z][a-zA-Z0-9]*;
      // Numeric entity: &#[0-9]+; or &#x[0-9a-fA-F]+;
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
            continue;
          }
        }
      }
      // Not a valid entity: emit '&' as text
      yield tok(TokenType.TEXT, i, i + 1);
      i += 1;
      continue;
    }

    // -----------------------------------------------------------------------
    // Triple braces: {{{ ... }}} (argument)
    // Must check before double braces.
    // -----------------------------------------------------------------------
    if (code === CC_OPEN_BRACE &&
      i + 2 < len &&
      source.charCodeAt(i + 1) === CC_OPEN_BRACE &&
      source.charCodeAt(i + 2) === CC_OPEN_BRACE) {
      yield tok(TokenType.ARGUMENT_OPEN, i, i + 3);
      i += 3;
      continue;
    }

    if (code === CC_CLOSE_BRACE &&
      i + 2 < len &&
      source.charCodeAt(i + 1) === CC_CLOSE_BRACE &&
      source.charCodeAt(i + 2) === CC_CLOSE_BRACE) {
      yield tok(TokenType.ARGUMENT_CLOSE, i, i + 3);
      i += 3;
      continue;
    }

    // -----------------------------------------------------------------------
    // Double braces: {{ ... }} (template)
    // -----------------------------------------------------------------------
    if (code === CC_OPEN_BRACE &&
      i + 1 < len &&
      source.charCodeAt(i + 1) === CC_OPEN_BRACE) {
      yield tok(TokenType.TEMPLATE_OPEN, i, i + 2);
      i += 2;
      continue;
    }

    if (code === CC_CLOSE_BRACE &&
      i + 1 < len &&
      source.charCodeAt(i + 1) === CC_CLOSE_BRACE) {
      yield tok(TokenType.TEMPLATE_CLOSE, i, i + 2);
      i += 2;
      continue;
    }

    // -----------------------------------------------------------------------
    // Double brackets: [[ ... ]] (wikilink)
    // Single bracket: [ ... ] (external link)
    // -----------------------------------------------------------------------
    if (code === CC_OPEN_BRACKET) {
      if (i + 1 < len && source.charCodeAt(i + 1) === CC_OPEN_BRACKET) {
        yield tok(TokenType.LINK_OPEN, i, i + 2);
        i += 2;
        continue;
      }
      yield tok(TokenType.EXT_LINK_OPEN, i, i + 1);
      i += 1;
      continue;
    }

    if (code === CC_CLOSE_BRACKET) {
      if (i + 1 < len && source.charCodeAt(i + 1) === CC_CLOSE_BRACKET) {
        yield tok(TokenType.LINK_CLOSE, i, i + 2);
        i += 2;
        continue;
      }
      yield tok(TokenType.EXT_LINK_CLOSE, i, i + 1);
      i += 1;
      continue;
    }

    // -----------------------------------------------------------------------
    // Pipe and double pipe: | and ||
    // -----------------------------------------------------------------------
    if (code === CC_PIPE) {
      if (i + 1 < len && source.charCodeAt(i + 1) === CC_PIPE) {
        yield tok(TokenType.DOUBLE_PIPE, i, i + 2);
        i += 2;
        continue;
      }
      yield tok(TokenType.PIPE, i, i + 1);
      i += 1;
      continue;
    }

    // -----------------------------------------------------------------------
    // Bang: '!!' (inline header cell separator, not at line start)
    // -----------------------------------------------------------------------
    if (code === CC_BANG) {
      if (i + 1 < len && source.charCodeAt(i + 1) === CC_BANG) {
        yield tok(TokenType.DOUBLE_BANG, i, i + 2);
        i += 2;
        continue;
      }
      // Single '!' not at line start is plain text
      yield tok(TokenType.TEXT, i, i + 1);
      i += 1;
      continue;
    }

    // -----------------------------------------------------------------------
    // Apostrophe runs: '' (italic), ''' (bold), ''''' (bold+italic)
    //
    // Emit the full run; the inline parser disambiguates.
    // -----------------------------------------------------------------------
    if (code === CC_APOSTROPHE) {
      const start = i;
      while (i < len && source.charCodeAt(i) === CC_APOSTROPHE) i++;
      const runLen = i - start;
      if (runLen >= 2) {
        yield tok(TokenType.APOSTROPHE_RUN, start, i);
      } else {
        // Single apostrophe: plain text
        yield tok(TokenType.TEXT, start, i);
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Tilde runs: ~~~ (sig), ~~~~ (sig+date), ~~~~~ (date)
    // -----------------------------------------------------------------------
    if (code === CC_TILDE) {
      const start = i;
      while (i < len && source.charCodeAt(i) === CC_TILDE) i++;
      const runLen = i - start;
      if (runLen >= 3 && runLen <= 5) {
        yield tok(TokenType.SIGNATURE, start, i);
      } else {
        // Not a signature run: plain text
        yield tok(TokenType.TEXT, start, i);
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Behavior switches: __TOC__, __NOTOC__, etc.
    //
    // Two underscores, then ALLCAPS word, then two underscores. Only
    // recognized words emit BEHAVIOR_SWITCH; others fall through as text.
    // -----------------------------------------------------------------------
    if (code === CC_UNDERSCORE &&
      i + 1 < len &&
      source.charCodeAt(i + 1) === CC_UNDERSCORE) {
      const start = i;
      let j = i + 2;
      // Scan the uppercase word
      while (j < len && isAsciiLetter(source.charCodeAt(j))) j++;
      // Check for closing '__'
      if (j + 1 < len &&
        source.charCodeAt(j) === CC_UNDERSCORE &&
        source.charCodeAt(j + 1) === CC_UNDERSCORE) {
        const word = source.slice(i + 2, j);
        if (BEHAVIOR_SWITCHES.has(word)) {
          yield tok(TokenType.BEHAVIOR_SWITCH, start, j + 2);
          i = j + 2;
          continue;
        }
      }
      // Not a recognized behavior switch: emit '__' as text
      yield tok(TokenType.TEXT, i, i + 2);
      i += 2;
      continue;
    }

    // -----------------------------------------------------------------------
    // Equals sign (not at line start): EQUALS
    //
    // At line start, '=' was already handled as HEADING_MARKER.
    // Trailing '=' for heading close is handled by a post-scan within
    // the heading context. For now, mid-line '=' becomes EQUALS (used
    // as template parameter separator by the block/inline parser).
    //
    // Heading close detection: We scan for trailing '=' before newline.
    // This requires looking ahead: the block parser will handle close
    // detection properly. Here we emit EQUALS for non-line-start '='.
    // -----------------------------------------------------------------------
    if (code === CC_EQUALS) {
      const start = i;
      while (i < len && source.charCodeAt(i) === CC_EQUALS) i++;
      yield tok(TokenType.EQUALS, start, i);
      continue;
    }

    // -----------------------------------------------------------------------
    // Plain text: accumulate everything that isn't a recognized delimiter.
    //
    // This is the "fallthrough" path. Characters that don't match any
    // pattern above are grouped into TEXT tokens. We consume as many
    // non-special characters as possible in one token to minimize the
    // total token count and reduce overhead for the block parser.
    //
    // The inner loop uses the DELIMITER lookup table. The `c < 128`
    // guard means non-ASCII characters (CJK, emoji, surrogate halves)
    // skip the table access entirely — they are never delimiters.
    // -----------------------------------------------------------------------
    {
      const start = i;
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c < 128 && DELIMITER[c]) break;
        i++;
      }
      yield tok(TokenType.TEXT, start, i);
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
