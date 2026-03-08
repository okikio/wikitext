/**
 * Dedicated tests for token.ts.
 *
 * Covers the TokenType constant map, the Token
 * interface contract, and the isToken() type guard with edge cases,
 * boundary values, and property-based invariants.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';
import * as fc from 'npm:fast-check';

import { isToken, TokenType } from './token.ts';
import type { Token } from './token.ts';

// ---------------------------------------------------------------------------
// TokenType constant map
// ---------------------------------------------------------------------------

describe('TokenType', () => {
  it('contains all expected text/whitespace types', () => {
    expect(TokenType.TEXT).toBe('TEXT');
    expect(TokenType.NEWLINE).toBe('NEWLINE');
    expect(TokenType.WHITESPACE).toBe('WHITESPACE');
  });

  it('contains heading types', () => {
    expect(TokenType.HEADING_MARKER).toBe('HEADING_MARKER');
    expect(TokenType.HEADING_MARKER_CLOSE).toBe('HEADING_MARKER_CLOSE');
  });

  it('contains list marker types', () => {
    expect(TokenType.BULLET).toBe('BULLET');
    expect(TokenType.HASH).toBe('HASH');
    expect(TokenType.COLON).toBe('COLON');
    expect(TokenType.SEMICOLON).toBe('SEMICOLON');
  });

  it('contains table types', () => {
    expect(TokenType.TABLE_OPEN).toBe('TABLE_OPEN');
    expect(TokenType.TABLE_CLOSE).toBe('TABLE_CLOSE');
    expect(TokenType.TABLE_ROW).toBe('TABLE_ROW');
    expect(TokenType.TABLE_CAPTION).toBe('TABLE_CAPTION');
    expect(TokenType.PIPE).toBe('PIPE');
    expect(TokenType.DOUBLE_PIPE).toBe('DOUBLE_PIPE');
    expect(TokenType.TABLE_HEADER_CELL).toBe('TABLE_HEADER_CELL');
    expect(TokenType.DOUBLE_BANG).toBe('DOUBLE_BANG');
  });

  it('contains inline delimiter types', () => {
    expect(TokenType.APOSTROPHE_RUN).toBe('APOSTROPHE_RUN');
    expect(TokenType.LINK_OPEN).toBe('LINK_OPEN');
    expect(TokenType.LINK_CLOSE).toBe('LINK_CLOSE');
    expect(TokenType.EXT_LINK_OPEN).toBe('EXT_LINK_OPEN');
    expect(TokenType.EXT_LINK_CLOSE).toBe('EXT_LINK_CLOSE');
    expect(TokenType.TEMPLATE_OPEN).toBe('TEMPLATE_OPEN');
    expect(TokenType.TEMPLATE_CLOSE).toBe('TEMPLATE_CLOSE');
    expect(TokenType.ARGUMENT_OPEN).toBe('ARGUMENT_OPEN');
    expect(TokenType.ARGUMENT_CLOSE).toBe('ARGUMENT_CLOSE');
  });

  it('contains HTML / extension tag types', () => {
    expect(TokenType.TAG_OPEN).toBe('TAG_OPEN');
    expect(TokenType.TAG_CLOSE).toBe('TAG_CLOSE');
    expect(TokenType.CLOSING_TAG_OPEN).toBe('CLOSING_TAG_OPEN');
    expect(TokenType.SELF_CLOSING_TAG_END).toBe('SELF_CLOSING_TAG_END');
    expect(TokenType.COMMENT_OPEN).toBe('COMMENT_OPEN');
    expect(TokenType.COMMENT_CLOSE).toBe('COMMENT_CLOSE');
    expect(TokenType.HTML_ENTITY).toBe('HTML_ENTITY');
  });

  it('contains special construct types', () => {
    expect(TokenType.SIGNATURE).toBe('SIGNATURE');
    expect(TokenType.BEHAVIOR_SWITCH).toBe('BEHAVIOR_SWITCH');
    expect(TokenType.PREFORMATTED_MARKER).toBe('PREFORMATTED_MARKER');
    expect(TokenType.THEMATIC_BREAK).toBe('THEMATIC_BREAK');
  });

  it('contains misc types', () => {
    expect(TokenType.EQUALS).toBe('EQUALS');
    expect(TokenType.EOF).toBe('EOF');
  });

  it('all values are unique strings', () => {
    const values = Object.values(TokenType);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) {
      expect(typeof v).toBe('string');
    }
  });

  it('has exactly 39 token types', () => {
    // Vocabulary changes are public-surface changes. Keeping the count
    // explicit forces additions or removals to be intentional.
    expect(Object.keys(TokenType).length).toBe(39);
  });

  it('keys match values (UPPER_SNAKE convention)', () => {
    for (const [key, value] of Object.entries(TokenType)) {
      expect(key).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// Token interface
// ---------------------------------------------------------------------------

describe('Token interface', () => {
  it('has type, start, and end fields', () => {
    const tok: Token = { type: TokenType.TEXT, start: 0, end: 5 };
    expect(tok.type).toBe('TEXT');
    expect(tok.start).toBe(0);
    expect(tok.end).toBe(5);
  });

  it('accepts zero-length tokens', () => {
    const tok: Token = { type: TokenType.EOF, start: 10, end: 10 };
    expect(tok.start).toBe(tok.end);
  });

  it('accepts any valid TokenType', () => {
    for (const tt of Object.values(TokenType)) {
      const tok: Token = { type: tt, start: 0, end: 1 };
      expect(tok.type).toBe(tt);
    }
  });
});

// ---------------------------------------------------------------------------
// isToken — basic cases
// ---------------------------------------------------------------------------

describe('isToken', () => {
  it('returns true for a valid Token', () => {
    expect(isToken({ type: TokenType.TEXT, start: 0, end: 5 })).toBe(true);
  });

  it('returns true for all known token types', () => {
    for (const tt of Object.values(TokenType)) {
      expect(isToken({ type: tt, start: 0, end: 1 })).toBe(true);
    }
  });

  it('returns true for a zero-length EOF token', () => {
    expect(isToken({ type: TokenType.EOF, start: 42, end: 42 })).toBe(true);
  });

  // -- Rejection cases --

  it('returns false for null', () => {
    expect(isToken(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isToken(undefined)).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isToken(42)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isToken('TEXT')).toBe(false);
  });

  it('returns false for a boolean', () => {
    expect(isToken(true)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isToken([TokenType.TEXT, 0, 5])).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isToken({})).toBe(false);
  });

  it('returns false when type is not a known TokenType', () => {
    expect(isToken({ type: 'UNKNOWN_TYPE', start: 0, end: 1 })).toBe(false);
  });

  it('returns false when type is missing', () => {
    expect(isToken({ start: 0, end: 5 })).toBe(false);
  });

  it('returns false when start is missing', () => {
    expect(isToken({ type: TokenType.TEXT, end: 5 })).toBe(false);
  });

  it('returns false when end is missing', () => {
    expect(isToken({ type: TokenType.TEXT, start: 0 })).toBe(false);
  });

  it('returns false when type is a number instead of string', () => {
    expect(isToken({ type: 1, start: 0, end: 5 })).toBe(false);
  });

  it('returns false when start is a string instead of number', () => {
    expect(isToken({ type: TokenType.TEXT, start: '0', end: 5 })).toBe(false);
  });

  it('returns false when end is a string instead of number', () => {
    expect(isToken({ type: TokenType.TEXT, start: 0, end: '5' })).toBe(false);
  });

  it('tolerates extra properties on a valid token', () => {
    expect(isToken({
      type: TokenType.TEXT, start: 0, end: 5, extra: 'data',
    })).toBe(true);
  });

  it('does not validate start <= end (runtime guard is structural only)', () => {
    // isToken is structural, not semantic — it doesn't check range validity.
    expect(isToken({ type: TokenType.TEXT, start: 10, end: 5 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isToken — property-based
// ---------------------------------------------------------------------------

describe('isToken — property-based', () => {
  const arbTokenType = fc.constantFrom(...Object.values(TokenType));

  it('accepts any object with valid shape', () => {
    fc.assert(
      fc.property(arbTokenType, fc.nat(), fc.nat(), (type, start, end) => {
        expect(isToken({ type, start, end })).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('rejects objects with random type strings', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !Object.values(TokenType).includes(s as TokenType)),
        fc.nat(),
        fc.nat(),
        (type, start, end) => {
          expect(isToken({ type, start, end })).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejects primitives', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (value) => {
          expect(isToken(value)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
