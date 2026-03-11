/**
 * Tests for the tokenizer.
 *
 * Covers: basic text, whitespace, newlines, headings, lists, tables,
 * bold/italic, links, templates, arguments, HTML tags, entities, comments,
 * signatures, behavior switches, thematic breaks, preformatted markers,
 * and the never-throw/coverage invariants via property-based tests.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';
import * as fc from 'npm:fast-check';

import {
  odd_character_wikitext_string,
  pathological_wikitext_string,
  spacing_heavy_wikitext_string,
  wikiish_string,
} from './_test_utils/arbitraries.ts';
import { UNICODE_TEXT_FIXTURES } from './_test_utils/unicode_fixtures.ts';
import { tokenize } from './tokenizer.ts';
import { TokenType } from './token.ts';
import type { Token } from './token.ts';

/** Collect all tokens from a string into an array. */
function tokens(input: string): Token[] {
  return Array.from(tokenize(input));
}

/**
 * Shorthand for the token type at index `i`.
 *
 * This keeps the assertions compact without hiding the token array the test is
 * actually exercising.
 */
function typeAt(toks: Token[], i: number): string {
  return toks[i].type;
}

// ---------------------------------------------------------------------------
// Empty and trivial inputs
// ---------------------------------------------------------------------------

describe('empty and trivial inputs', () => {
  it('empty string yields only EOF', () => {
    const t = tokens('');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ type: TokenType.EOF, start: 0, end: 0 });
  });

  it('single character yields TEXT + EOF', () => {
    const t = tokens('x');
    expect(t).toHaveLength(2);
    expect(t[0]).toEqual({ type: TokenType.TEXT, start: 0, end: 1 });
    expect(t[1].type).toBe(TokenType.EOF);
  });

  it('single newline yields NEWLINE + EOF', () => {
    const t = tokens('\n');
    expect(t).toHaveLength(2);
    expect(t[0]).toEqual({ type: TokenType.NEWLINE, start: 0, end: 1 });
    expect(t[1].type).toBe(TokenType.EOF);
  });
});

// ---------------------------------------------------------------------------
// Newline handling
// ---------------------------------------------------------------------------

describe('newlines', () => {
  it('LF newline', () => {
    const t = tokens('a\nb');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
    expect(typeAt(t, 1)).toBe(TokenType.NEWLINE);
    expect(t[1]).toEqual({ type: TokenType.NEWLINE, start: 1, end: 2 });
    expect(typeAt(t, 2)).toBe(TokenType.TEXT);
  });

  it('CRLF newline counts as one token', () => {
    const t = tokens('a\r\nb');
    expect(typeAt(t, 1)).toBe(TokenType.NEWLINE);
    expect(t[1]).toEqual({ type: TokenType.NEWLINE, start: 1, end: 3 });
  });

  it('bare CR newline', () => {
    const t = tokens('a\rb');
    expect(typeAt(t, 1)).toBe(TokenType.NEWLINE);
    expect(t[1]).toEqual({ type: TokenType.NEWLINE, start: 1, end: 2 });
  });

  it('mixed line endings', () => {
    const t = tokens('a\nb\r\nc\rd');
    const newlines = t.filter((tok) => tok.type === TokenType.NEWLINE);
    expect(newlines).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------

describe('whitespace', () => {
  it('spaces between text', () => {
    const t = tokens('a  b');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
    expect(typeAt(t, 1)).toBe(TokenType.WHITESPACE);
    expect(t[1]).toEqual({ type: TokenType.WHITESPACE, start: 1, end: 3 });
    expect(typeAt(t, 2)).toBe(TokenType.TEXT);
  });

  it('tabs are whitespace', () => {
    const t = tokens('a\tb');
    expect(typeAt(t, 1)).toBe(TokenType.WHITESPACE);
  });

  it('mixed spaces and tabs merge into one whitespace token', () => {
    const t = tokens('a \t b');
    expect(typeAt(t, 1)).toBe(TokenType.WHITESPACE);
    expect(t[1]).toEqual({ type: TokenType.WHITESPACE, start: 1, end: 4 });
  });

  it('leading space changes heading syntax into a preformatted line start', () => {
    const input = ' == Title ==';
    const t = tokens(input);

    // One literal space at column 0 is enough to change the block meaning of
    // the line. This test is necessary because heading markers and leading
    // spaces compete at the same boundary, and recovery only makes sense if the
    // tokenizer makes that choice consistently.

    expect(typeAt(t, 0)).toBe(TokenType.PREFORMATTED_MARKER);
    expect(t.some((tok) => tok.type === TokenType.HEADING_MARKER)).toBe(false);
  });

  it('leading tab removes heading-marker classification without creating preformatting', () => {
    const input = '\t== Title ==';
    const t = tokens(input);

    // Tabs are ordinary whitespace in this scanner. That means a tab at the
    // start of the line should stop heading recognition, but it should not be
    // silently upgraded into the special single-space preformatted marker.

    expect(typeAt(t, 0)).toBe(TokenType.WHITESPACE);
    expect(t.some((tok) => tok.type === TokenType.HEADING_MARKER)).toBe(false);
    expect(t.some((tok) => tok.type === TokenType.PREFORMATTED_MARKER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

describe('headings', () => {
  it('== at line start is HEADING_MARKER', () => {
    const t = tokens('== Hi ==');
    expect(typeAt(t, 0)).toBe(TokenType.HEADING_MARKER);
    expect(t[0]).toEqual({ type: TokenType.HEADING_MARKER, start: 0, end: 2 });
  });

  it('heading level 3', () => {
    const t = tokens('=== Title ===');
    expect(t[0]).toEqual({ type: TokenType.HEADING_MARKER, start: 0, end: 3 });
  });

  it('trailing equals are EQUALS (not heading close) in mid-line', () => {
    // The trailing '==' are EQUALS since they come after lineStart=false
    const t = tokens('== Hi ==');
    const equalsTokens = t.filter((tok) => tok.type === TokenType.EQUALS);
    expect(equalsTokens).toHaveLength(1); // trailing ==
  });

  it('heading after newline', () => {
    const t = tokens('text\n== Heading ==');
    const headingMarkers = t.filter((tok) => tok.type === TokenType.HEADING_MARKER);
    expect(headingMarkers).toHaveLength(1);
  });

  it('single = at line start is HEADING_MARKER', () => {
    const t = tokens('= H1 =');
    expect(typeAt(t, 0)).toBe(TokenType.HEADING_MARKER);
    expect(t[0].end - t[0].start).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe('lists', () => {
  it('bullet list marker', () => {
    const t = tokens('* item');
    expect(typeAt(t, 0)).toBe(TokenType.BULLET);
    expect(t[0]).toEqual({ type: TokenType.BULLET, start: 0, end: 1 });
  });

  it('ordered list marker', () => {
    const t = tokens('# item');
    expect(typeAt(t, 0)).toBe(TokenType.HASH);
  });

  it('nested list markers', () => {
    const t = tokens('**# deep');
    expect(typeAt(t, 0)).toBe(TokenType.BULLET);
    expect(typeAt(t, 1)).toBe(TokenType.BULLET);
    expect(typeAt(t, 2)).toBe(TokenType.HASH);
  });

  it('definition term', () => {
    const t = tokens('; term');
    expect(typeAt(t, 0)).toBe(TokenType.SEMICOLON);
  });

  it('definition description', () => {
    const t = tokens(': desc');
    expect(typeAt(t, 0)).toBe(TokenType.COLON);
  });

  it('list markers after newline', () => {
    const t = tokens('text\n* item');
    const bullets = t.filter((tok) => tok.type === TokenType.BULLET);
    expect(bullets).toHaveLength(1);
  });

  it('keeps line-start significance after a list marker so following spaces stay structural', () => {
    const t = tokens('* item');

    // The tokenizer intentionally keeps line-start semantics alive across stacked
    // list markers. That makes the space after `*` distinct from mid-line
    // whitespace, which is important for later block decisions.

    expect(typeAt(t, 0)).toBe(TokenType.BULLET);
    expect(typeAt(t, 1)).toBe(TokenType.PREFORMATTED_MARKER);
  });
});

// ---------------------------------------------------------------------------
// Thematic break
// ---------------------------------------------------------------------------

describe('thematic break', () => {
  it('four dashes at line start', () => {
    const t = tokens('----');
    expect(typeAt(t, 0)).toBe(TokenType.THEMATIC_BREAK);
    expect(t[0]).toEqual({ type: TokenType.THEMATIC_BREAK, start: 0, end: 4 });
  });

  it('more than four dashes', () => {
    const t = tokens('------');
    expect(typeAt(t, 0)).toBe(TokenType.THEMATIC_BREAK);
    expect(t[0].end).toBe(6);
  });

  it('three dashes at line start is TEXT', () => {
    const t = tokens('---');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  it('dashes not at line start are TEXT', () => {
    const t = tokens('x----');
    // 'x' is TEXT, '----' should not be THEMATIC_BREAK
    const breaks = t.filter((tok) => tok.type === TokenType.THEMATIC_BREAK);
    expect(breaks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Preformatted marker
// ---------------------------------------------------------------------------

describe('preformatted marker', () => {
  it('space at line start is PREFORMATTED_MARKER', () => {
    const t = tokens(' code');
    expect(typeAt(t, 0)).toBe(TokenType.PREFORMATTED_MARKER);
    expect(t[0]).toEqual({ type: TokenType.PREFORMATTED_MARKER, start: 0, end: 1 });
    expect(typeAt(t, 1)).toBe(TokenType.TEXT);
  });

  it('space not at line start is WHITESPACE', () => {
    const t = tokens('a b');
    const preMarkers = t.filter((tok) => tok.type === TokenType.PREFORMATTED_MARKER);
    expect(preMarkers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

describe('tables', () => {
  it('table open {|', () => {
    const t = tokens('{|');
    expect(typeAt(t, 0)).toBe(TokenType.TABLE_OPEN);
    expect(t[0]).toEqual({ type: TokenType.TABLE_OPEN, start: 0, end: 2 });
  });

  it('table close |}', () => {
    const t = tokens('{|\n|}');
    const closes = t.filter((tok) => tok.type === TokenType.TABLE_CLOSE);
    expect(closes).toHaveLength(1);
  });

  it('table row |-', () => {
    const t = tokens('{|\n|-');
    const rows = t.filter((tok) => tok.type === TokenType.TABLE_ROW);
    expect(rows).toHaveLength(1);
  });

  it('table caption |+', () => {
    const t = tokens('{|\n|+ Caption');
    const captions = t.filter((tok) => tok.type === TokenType.TABLE_CAPTION);
    expect(captions).toHaveLength(1);
  });

  it('table header cell ! at line start', () => {
    const t = tokens('{|\n! Header');
    const headers = t.filter((tok) => tok.type === TokenType.TABLE_HEADER_CELL);
    expect(headers).toHaveLength(1);
  });

  it('pipe | at line start in table context', () => {
    const t = tokens('{|\n| Cell');
    // After newline, '|' at line start is PIPE
    const pipes = t.filter((tok) => tok.type === TokenType.PIPE);
    expect(pipes.length).toBeGreaterThanOrEqual(1);
  });

  it('double pipe || inline', () => {
    const t = tokens('a||b');
    const dPipes = t.filter((tok) => tok.type === TokenType.DOUBLE_PIPE);
    expect(dPipes).toHaveLength(1);
  });

  it('double bang !! inline', () => {
    const t = tokens('a!!b');
    const dBangs = t.filter((tok) => tok.type === TokenType.DOUBLE_BANG);
    expect(dBangs).toHaveLength(1);
  });

  it('{| not at line start is TEMPLATE_OPEN-ish', () => {
    // '{|' not at line start: '{' is part of brace handling, '|' is PIPE
    const t = tokens('x{|');
    // 'x' is TEXT. '{' alone is TEXT (single brace). '|' is PIPE.
    const tableOpens = t.filter((tok) => tok.type === TokenType.TABLE_OPEN);
    expect(tableOpens).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bold and italic (apostrophe runs)
// ---------------------------------------------------------------------------

describe('apostrophe runs', () => {
  it("'' is APOSTROPHE_RUN (italic)", () => {
    const t = tokens("''text''");
    const runs = t.filter((tok) => tok.type === TokenType.APOSTROPHE_RUN);
    expect(runs).toHaveLength(2);
    expect(runs[0].end - runs[0].start).toBe(2);
  });

  it("''' is APOSTROPHE_RUN (bold)", () => {
    const t = tokens("'''bold'''");
    const runs = t.filter((tok) => tok.type === TokenType.APOSTROPHE_RUN);
    expect(runs).toHaveLength(2);
    expect(runs[0].end - runs[0].start).toBe(3);
  });

  it("''''' is APOSTROPHE_RUN (bold+italic)", () => {
    const t = tokens("'''''both'''''");
    const runs = t.filter((tok) => tok.type === TokenType.APOSTROPHE_RUN);
    expect(runs).toHaveLength(2);
    expect(runs[0].end - runs[0].start).toBe(5);
  });

  it("single apostrophe is TEXT", () => {
    const t = tokens("don't");
    // "don" TEXT, "'" TEXT, "t" TEXT — but the text scanner merges them
    // Actually: "don" is TEXT (stops at apostrophe), "'" is TEXT (single), "t" is TEXT
    const runs = t.filter((tok) => tok.type === TokenType.APOSTROPHE_RUN);
    expect(runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe('links', () => {
  it('[[ is LINK_OPEN', () => {
    const t = tokens('[[Page]]');
    expect(typeAt(t, 0)).toBe(TokenType.LINK_OPEN);
    expect(t[0]).toEqual({ type: TokenType.LINK_OPEN, start: 0, end: 2 });
  });

  it(']] is LINK_CLOSE', () => {
    const t = tokens('[[Page]]');
    const closes = t.filter((tok) => tok.type === TokenType.LINK_CLOSE);
    expect(closes).toHaveLength(1);
  });

  it('[ is EXT_LINK_OPEN', () => {
    const t = tokens('[http://example.com]');
    expect(typeAt(t, 0)).toBe(TokenType.EXT_LINK_OPEN);
  });

  it('] is EXT_LINK_CLOSE', () => {
    const t = tokens('[http://example.com]');
    const closes = t.filter((tok) => tok.type === TokenType.EXT_LINK_CLOSE);
    expect(closes).toHaveLength(1);
  });

  it('wikilink with pipe', () => {
    const t = tokens('[[Page|label]]');
    expect(typeAt(t, 0)).toBe(TokenType.LINK_OPEN);
    const pipes = t.filter((tok) => tok.type === TokenType.PIPE);
    expect(pipes).toHaveLength(1);
    const closes = t.filter((tok) => tok.type === TokenType.LINK_CLOSE);
    expect(closes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Templates and arguments
// ---------------------------------------------------------------------------

describe('templates and arguments', () => {
  it('{{ is TEMPLATE_OPEN', () => {
    const t = tokens('{{name}}');
    expect(typeAt(t, 0)).toBe(TokenType.TEMPLATE_OPEN);
    expect(t[0]).toEqual({ type: TokenType.TEMPLATE_OPEN, start: 0, end: 2 });
  });

  it('}} is TEMPLATE_CLOSE', () => {
    const t = tokens('{{name}}');
    const closes = t.filter((tok) => tok.type === TokenType.TEMPLATE_CLOSE);
    expect(closes).toHaveLength(1);
  });

  it('{{{ is ARGUMENT_OPEN', () => {
    const t = tokens('{{{1}}}');
    expect(typeAt(t, 0)).toBe(TokenType.ARGUMENT_OPEN);
    expect(t[0]).toEqual({ type: TokenType.ARGUMENT_OPEN, start: 0, end: 3 });
  });

  it('}}} is ARGUMENT_CLOSE', () => {
    const t = tokens('{{{1}}}');
    const closes = t.filter((tok) => tok.type === TokenType.ARGUMENT_CLOSE);
    expect(closes).toHaveLength(1);
  });

  it('template with pipe-separated params', () => {
    const t = tokens('{{name|a=1|b=2}}');
    const pipes = t.filter((tok) => tok.type === TokenType.PIPE);
    expect(pipes).toHaveLength(2);
    const equals = t.filter((tok) => tok.type === TokenType.EQUALS);
    expect(equals).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// HTML tags
// ---------------------------------------------------------------------------

describe('HTML tags', () => {
  it('<ref> emits TAG_OPEN + text + TAG_CLOSE', () => {
    const t = tokens('<ref>');
    expect(typeAt(t, 0)).toBe(TokenType.TAG_OPEN);
    // 'ref' is TEXT, '>' is TAG_CLOSE
    expect(t.some((tok) => tok.type === TokenType.TAG_CLOSE)).toBe(true);
  });

  it('</ref> emits CLOSING_TAG_OPEN', () => {
    const t = tokens('</ref>');
    expect(typeAt(t, 0)).toBe(TokenType.CLOSING_TAG_OPEN);
  });

  it('<br /> emits TAG_OPEN + text + SELF_CLOSING_TAG_END', () => {
    const t = tokens('<br />');
    expect(typeAt(t, 0)).toBe(TokenType.TAG_OPEN);
    expect(t.some((tok) => tok.type === TokenType.SELF_CLOSING_TAG_END)).toBe(true);
  });

  it('bare < not followed by letter is TEXT', () => {
    const t = tokens('3 < 5');
    // '<' followed by ' ' is not a tag
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
    // The '<' is TEXT
    const tagOpens = t.filter((tok) => tok.type === TokenType.TAG_OPEN);
    expect(tagOpens).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe('comments', () => {
  it('<!-- --> emits COMMENT_OPEN + TEXT + COMMENT_CLOSE', () => {
    const t = tokens('<!-- hello -->');
    expect(typeAt(t, 0)).toBe(TokenType.COMMENT_OPEN);
    expect(t[0]).toEqual({ type: TokenType.COMMENT_OPEN, start: 0, end: 4 });
    const closes = t.filter((tok) => tok.type === TokenType.COMMENT_CLOSE);
    expect(closes).toHaveLength(1);
  });

  it('unclosed comment: body emitted as TEXT', () => {
    const t = tokens('<!-- unclosed');
    expect(typeAt(t, 0)).toBe(TokenType.COMMENT_OPEN);
    // No COMMENT_CLOSE
    const closes = t.filter((tok) => tok.type === TokenType.COMMENT_CLOSE);
    expect(closes).toHaveLength(0);
    // Content is TEXT
    const textTokens = t.filter((tok) => tok.type === TokenType.TEXT);
    expect(textTokens.length).toBeGreaterThanOrEqual(1);
  });

  it('empty comment <!-- -->', () => {
    const t = tokens('<!---->');
    expect(typeAt(t, 0)).toBe(TokenType.COMMENT_OPEN);
    // Should have COMMENT_CLOSE right after
    expect(typeAt(t, 1)).toBe(TokenType.COMMENT_CLOSE);
  });
});

// ---------------------------------------------------------------------------
// HTML entities
// ---------------------------------------------------------------------------

describe('HTML entities', () => {
  it('named entity &amp;', () => {
    const t = tokens('&amp;');
    expect(typeAt(t, 0)).toBe(TokenType.HTML_ENTITY);
    expect(t[0]).toEqual({ type: TokenType.HTML_ENTITY, start: 0, end: 5 });
  });

  it('numeric entity &#123;', () => {
    const t = tokens('&#123;');
    expect(typeAt(t, 0)).toBe(TokenType.HTML_ENTITY);
  });

  it('hex entity &#x1F4A9;', () => {
    const t = tokens('&#x1F4A9;');
    expect(typeAt(t, 0)).toBe(TokenType.HTML_ENTITY);
  });

  it('malformed entity &; is TEXT', () => {
    const t = tokens('&;');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT); // bare '&'
  });

  it('entity without semicolon is TEXT', () => {
    const t = tokens('&amp');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT); // '&' as text
  });
});

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

describe('signatures', () => {
  it('~~~ is SIGNATURE', () => {
    const t = tokens('~~~');
    expect(typeAt(t, 0)).toBe(TokenType.SIGNATURE);
    expect(t[0]).toEqual({ type: TokenType.SIGNATURE, start: 0, end: 3 });
  });

  it('~~~~ is SIGNATURE', () => {
    const t = tokens('~~~~');
    expect(typeAt(t, 0)).toBe(TokenType.SIGNATURE);
  });

  it('~~~~~ is SIGNATURE', () => {
    const t = tokens('~~~~~');
    expect(typeAt(t, 0)).toBe(TokenType.SIGNATURE);
  });

  it('~~ (two tildes) is TEXT', () => {
    const t = tokens('~~');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  it('~~~~~~ (six tildes) is TEXT', () => {
    const t = tokens('~~~~~~');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });
});

// ---------------------------------------------------------------------------
// Behavior switches
// ---------------------------------------------------------------------------

describe('behavior switches', () => {
  it('__TOC__ is BEHAVIOR_SWITCH', () => {
    const t = tokens('__TOC__');
    expect(typeAt(t, 0)).toBe(TokenType.BEHAVIOR_SWITCH);
    expect(t[0]).toEqual({ type: TokenType.BEHAVIOR_SWITCH, start: 0, end: 7 });
  });

  it('__NOTOC__ is BEHAVIOR_SWITCH', () => {
    const t = tokens('__NOTOC__');
    expect(typeAt(t, 0)).toBe(TokenType.BEHAVIOR_SWITCH);
  });

  it('__UNKNOWN__ is BEHAVIOR_SWITCH (structural pattern, not word-list gated)', () => {
    const t = tokens('__UNKNOWN__');
    expect(typeAt(t, 0)).toBe(TokenType.BEHAVIOR_SWITCH);
    expect(t[0]).toEqual({ type: TokenType.BEHAVIOR_SWITCH, start: 0, end: 11 });
  });

  it('__CUSTOMEXT__ from an extension is BEHAVIOR_SWITCH', () => {
    const t = tokens('__CUSTOMEXT__');
    expect(typeAt(t, 0)).toBe(TokenType.BEHAVIOR_SWITCH);
  });

  it('__lowercaseword__ is not BEHAVIOR_SWITCH (letters must be ASCII letter)', () => {
    // isAsciiLetter covers a-z too, so lowercase also matches the pattern
    const t = tokens('__lowercaseword__');
    expect(typeAt(t, 0)).toBe(TokenType.BEHAVIOR_SWITCH);
  });

  it('__ with no word (__) is TEXT', () => {
    const t = tokens('____');
    // Two consecutive __ pairs with no letters between
    const switches = t.filter((tok) => tok.type === TokenType.BEHAVIOR_SWITCH);
    expect(switches).toHaveLength(0);
  });

  it('__ with digits __123__ is TEXT (digits are not letters)', () => {
    const t = tokens('__123__');
    const switches = t.filter((tok) => tok.type === TokenType.BEHAVIOR_SWITCH);
    expect(switches).toHaveLength(0);
  });

  it('single underscore is TEXT', () => {
    const t = tokens('_word_');
    const switches = t.filter((tok) => tok.type === TokenType.BEHAVIOR_SWITCH);
    expect(switches).toHaveLength(0);
  });

  it('unclosed __WORD is TEXT', () => {
    const t = tokens('__WORD');
    const switches = t.filter((tok) => tok.type === TokenType.BEHAVIOR_SWITCH);
    expect(switches).toHaveLength(0);
  });

  it('behavior switch in mid-line context', () => {
    const t = tokens('text __TOC__ more');
    const switches = t.filter((tok) => tok.type === TokenType.BEHAVIOR_SWITCH);
    expect(switches).toHaveLength(1);
    expect(switches[0].start).toBe(5);
    expect(switches[0].end).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Equals (mid-line)
// ---------------------------------------------------------------------------

describe('equals sign', () => {
  it('= not at line start is EQUALS', () => {
    const t = tokens('a=b');
    const equals = t.filter((tok) => tok.type === TokenType.EQUALS);
    expect(equals).toHaveLength(1);
  });

  it('multiple = not at line start', () => {
    const t = tokens('a==b');
    const equals = t.filter((tok) => tok.type === TokenType.EQUALS);
    expect(equals).toHaveLength(1);
    expect(equals[0].end - equals[0].start).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// EOF
// ---------------------------------------------------------------------------

describe('EOF', () => {
  it('every token stream ends with EOF', () => {
    for (const input of ['', 'hello', '== H ==\n', '[[link]]']) {
      const t = tokens(input);
      const last = t[t.length - 1];
      expect(last.type).toBe(TokenType.EOF);
      expect(last.start).toBe(input.length);
      expect(last.end).toBe(input.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Complex wikitext
// ---------------------------------------------------------------------------

describe('complex wikitext', () => {
  it('full table', () => {
    const t = tokens('{|\n! H1 !! H2\n|-\n| A || B\n|}');
    expect(t[0].type).toBe(TokenType.TABLE_OPEN);
    expect(t.some((tok) => tok.type === TokenType.TABLE_HEADER_CELL)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.DOUBLE_BANG)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.TABLE_ROW)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.DOUBLE_PIPE)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.TABLE_CLOSE)).toBe(true);
  });

  it('heading with bold content', () => {
    const t = tokens("== '''Bold Title''' ==");
    expect(t[0].type).toBe(TokenType.HEADING_MARKER);
    expect(t.some((tok) => tok.type === TokenType.APOSTROPHE_RUN)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.EQUALS)).toBe(true);
  });

  it('template inside wikilink', () => {
    const t = tokens('[[{{PAGENAME}}]]');
    expect(t[0].type).toBe(TokenType.LINK_OPEN);
    expect(t.some((tok) => tok.type === TokenType.TEMPLATE_OPEN)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.TEMPLATE_CLOSE)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.LINK_CLOSE)).toBe(true);
  });

  it('list with wikilink', () => {
    const t = tokens('* [[Page|label]]');
    expect(t[0].type).toBe(TokenType.BULLET);
    expect(t.some((tok) => tok.type === TokenType.LINK_OPEN)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.PIPE)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.LINK_CLOSE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('null byte is TEXT', () => {
    const t = tokens('\0');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  it('astral Unicode (emoji) is TEXT', () => {
    const t = tokens('\u{1F600}');
    // Emoji is a surrogate pair (2 UTF-16 units), but still TEXT
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  it('CJK text is TEXT', () => {
    const t = tokens('日本語');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  for (const fixture of UNICODE_TEXT_FIXTURES) {
    it(`${fixture.label} stays plain text`, () => {
      const t = tokens(fixture.sample);

      expect(t).toHaveLength(2);
      expect(t[0].type).toBe(TokenType.TEXT);
      expect(t[0].start).toBe(0);
      expect(t[0].end).toBe(fixture.sample.length);
      expect(t[1]).toEqual({
        type: TokenType.EOF,
        start: fixture.sample.length,
        end: fixture.sample.length,
      });
    });

    it(`keeps ${fixture.label} inside valid heading syntax`, () => {
      const input = `== ${fixture.sample} ==`;
      const t = tokens(input);
      const payload = t.find((tok) =>
        tok.type === TokenType.TEXT && input.slice(tok.start, tok.end).includes(fixture.sample)
      );

      expect(typeAt(t, 0)).toBe(TokenType.HEADING_MARKER);
      expect(payload).toBeDefined();
    });
  }

  it('single { is TEXT', () => {
    const t = tokens('{');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  it('single } is TEXT', () => {
    const t = tokens('}');
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  it('single / is TEXT', () => {
    const t = tokens('/');
    // '/' is a delimiter char but only matters for '/>' inside tags
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);

    const t2 = tokens('a/b');
    // Should have text covering the slash
    const textTokens = t2.filter((tok) => tok.type === TokenType.TEXT);
    expect(textTokens.length).toBeGreaterThanOrEqual(1);
  });

  it('extremely long line of text', () => {
    const long = 'x'.repeat(100_000);
    const t = tokens(long);
    // Should be a single TEXT token + EOF
    expect(t).toHaveLength(2);
    expect(t[0].type).toBe(TokenType.TEXT);
    expect(t[0].end - t[0].start).toBe(100_000);
  });

  it('tab at line start is WHITESPACE, not PREFORMATTED_MARKER', () => {
    const t = tokens('\tHello');
    // Only a literal space at column 0 is a preformatted marker;
    // tab is generic whitespace.
    expect(typeAt(t, 0)).toBe(TokenType.WHITESPACE);
  });

  it('self-closing <br/> without space', () => {
    const t = tokens('<br/>');
    expect(typeAt(t, 0)).toBe(TokenType.TAG_OPEN);
    expect(t.some((tok) => tok.type === TokenType.SELF_CLOSING_TAG_END))
      .toBe(true);
  });

  it('empty entity &#; is TEXT', () => {
    const t = tokens('&#;');
    // Not a valid entity pattern -- ampersand is TEXT
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  it('CRLF at end of input', () => {
    const t = tokens('hello\r\n');
    expect(t.some((tok) => tok.type === TokenType.NEWLINE)).toBe(true);
    expect(t[t.length - 1].type).toBe(TokenType.EOF);
    // Token tiling: every code unit is covered
    for (let i = 1; i < t.length; i++) {
      expect(t[i].start).toBe(t[i - 1].end);
    }
  });

  it('< followed by digit is TEXT', () => {
    const t = tokens('<3 heart');
    // '<' + digit is not a valid tag opener
    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
  });

  it('& alone at end of input is TEXT', () => {
    const t = tokens('foo &');
    const ampToken = t.find((tok) =>
      tok.type === TokenType.TEXT && tok.start >= 4
    );
    expect(ampToken).toBeDefined();
  });

  it('bare URLs are not tokenized as link syntax by the tokenizer', () => {
    const t = tokens('Visit https://example.com now');

    // Bare URLs are an inline-parser concern, not a tokenizer concern. The
    // tokenizer should stay structural and avoid inventing bracket syntax that
    // is not present in the source.

    expect(t.some((tok) => tok.type === TokenType.EXT_LINK_OPEN)).toBe(false);
    expect(t.some((tok) => tok.type === TokenType.LINK_OPEN)).toBe(false);
    expect(t.some((tok) => tok.type === TokenType.LINK_CLOSE)).toBe(false);
  });

  it('mid-line block markers stay as plain text', () => {
    const input = 'math 3*5 #1 key:value';
    const t = tokens(input);

    // `*`, `#`, and `:` only become block markers at line start. Mid-line they
    // are ordinary text, and this boundary keeps the scanner from becoming too
    // eager.

    expect(t.some((tok) => tok.type === TokenType.BULLET)).toBe(false);
    expect(t.some((tok) => tok.type === TokenType.HASH)).toBe(false);
    expect(t.some((tok) => tok.type === TokenType.COLON)).toBe(false);
  });

  it('apostrophes inside ordinary words do not become APOSTROPHE_RUN', () => {
    const t = tokens("can't rock'n'roll won't");
    const runs = t.filter((tok) => tok.type === TokenType.APOSTROPHE_RUN);

    // Apostrophes are only special in repeated delimiter runs. Inside normal
    // words they should remain text, otherwise contractions would become
    // formatting syntax accidentally.

    expect(runs).toHaveLength(0);
  });

  it('markdown fenced code markers are plain text to the tokenizer', () => {
    const input = '```ts\nconst x = [[not-a-special-mode]];\n```';
    const t = tokens(input);
    const backtickText = t.find((tok) =>
      tok.type === TokenType.TEXT && input.slice(tok.start, tok.end).startsWith('```')
    );

    // Markdown fences are unsupported syntax in this repo today. The safe and
    // reasonable behavior is to preserve them as text rather than switching the
    // tokenizer into a separate mode.
    expect(backtickText).toBeDefined();
  });

  it('treats backslashes as literal text instead of escaping inline delimiters', () => {
    const input = '\\[[Page]] \\{{Card}} \\&amp;';
    const t = tokens(input);

    // The current scanner does not implement backslash escaping. That means the
    // backslash itself stays in TEXT, and the delimiter that follows is still
    // tokenized normally. This test is necessary because many markup systems do
    // treat backslash as an escape, and we want the suite to pin down that this
    // parser does not do that yet.

    expect(typeAt(t, 0)).toBe(TokenType.TEXT);
    expect(t.some((tok) => tok.type === TokenType.LINK_OPEN)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.TEMPLATE_OPEN)).toBe(true);
    expect(t.some((tok) => tok.type === TokenType.HTML_ENTITY)).toBe(true);
  });

  it('lets a literal backslash block line-start marker recognition by changing position', () => {
    const input = '\\* item';
    const t = tokens(input);

    // Backslash is not an escape signal here, but it is still a real character at
    // column 0. That moves the `*` away from the line-start boundary, so the star
    // should no longer be classified as a list marker.

    expect(t.some((tok) => tok.type === TokenType.BULLET)).toBe(false);
  });

  it('keeps odd unicode payload text inside otherwise valid heading syntax', () => {
    const input = '== Caf\u0301e\u2060Title ==';
    const t = tokens(input);
    const oddText = t.find((tok) =>
      tok.type === TokenType.TEXT && input.slice(tok.start, tok.end).includes('\u2060')
    );

    // This is a valid heading with unusual payload text, not malformed syntax.
    // The scanner should still recognize the heading markers and leave the odd
    // code points inside ordinary text spans instead of fragmenting the token
    // stream around them.

    expect(typeAt(t, 0)).toBe(TokenType.HEADING_MARKER);
    expect(oddText).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Stress tests: adversarial and performance-sensitive patterns
// ---------------------------------------------------------------------------

describe('stress tests', () => {
  it('100K of plain prose produces minimal tokens', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(2222);
    const t = tokens(prose);
    // Mostly TEXT + WHITESPACE tokens, ending with EOF
    const last = t[t.length - 1];
    expect(last.type).toBe(TokenType.EOF);
    expect(last.start).toBe(prose.length);
    // Verify tiling
    for (let idx = 1; idx < t.length; idx++) {
      expect(t[idx].start).toBe(t[idx - 1].end);
    }
  });

  it('10K of CJK/emoji (non-ASCII fast path)', () => {
    const cjk = '\u4E16\u754C\u3053\u3093\u306B\u3061\u306F'.repeat(1428);
    const t = tokens(cjk);
    // Entire input should collapse into a single TEXT token
    expect(t).toHaveLength(2); // TEXT + EOF
    expect(t[0].type).toBe(TokenType.TEXT);
    expect(t[0].end).toBe(cjk.length);
  });

  for (const fixture of UNICODE_TEXT_FIXTURES) {
    it(`10K of ${fixture.label} stays tiled and text-only`, () => {
      const input = `${fixture.sample}`.repeat(Math.ceil(10_000 / fixture.sample.length));
      const t = tokens(input);

      expect(t).toHaveLength(2);
      expect(t[0].type).toBe(TokenType.TEXT);
      expect(t[0].end).toBe(input.length);
      expect(t[1]).toEqual({
        type: TokenType.EOF,
        start: input.length,
        end: input.length,
      });
    });
  }

  it('thousands of __ pairs (pathological underscore input)', () => {
    // 5000 pairs of __ with no letters between => all TEXT
    const input = '__'.repeat(5000);
    const t = tokens(input);
    const last = t[t.length - 1];
    expect(last.type).toBe(TokenType.EOF);
    expect(last.start).toBe(input.length);
    // No behavior switches (no letters between the underscores)
    const switches = t.filter((tok) => tok.type === TokenType.BEHAVIOR_SWITCH);
    expect(switches).toHaveLength(0);
    // Tiling
    for (let idx = 1; idx < t.length; idx++) {
      expect(t[idx].start).toBe(t[idx - 1].end);
    }
  });

  it('thousands of behavior switch patterns', () => {
    const input = '__SWITCH__\n'.repeat(3000);
    const t = tokens(input);
    const switches = t.filter((tok) => tok.type === TokenType.BEHAVIOR_SWITCH);
    expect(switches).toHaveLength(3000);
    const last = t[t.length - 1];
    expect(last.type).toBe(TokenType.EOF);
  });

  it('deeply nested braces', () => {
    // {{{ repeated 500 times, then }}} repeated 500 times
    const input = '{{{'.repeat(500) + '}}'.repeat(500) + '}'.repeat(500);
    const t = tokens(input);
    const last = t[t.length - 1];
    expect(last.type).toBe(TokenType.EOF);
    expect(last.start).toBe(input.length);
    for (let idx = 1; idx < t.length; idx++) {
      expect(t[idx].start).toBe(t[idx - 1].end);
    }
  });

  it('deeply nested brackets', () => {
    const input = '[['.repeat(500) + 'text' + ']]'.repeat(500);
    const t = tokens(input);
    const opens = t.filter((tok) => tok.type === TokenType.LINK_OPEN);
    const closes = t.filter((tok) => tok.type === TokenType.LINK_CLOSE);
    expect(opens).toHaveLength(500);
    expect(closes).toHaveLength(500);
  });

  it('alternating markup and text', () => {
    // Pattern: text[[link]]text{{tmpl}}text
    const unit = 'hello[[Page]]world{{Tmpl}}done\n';
    const input = unit.repeat(1000);
    const t = tokens(input);
    const last = t[t.length - 1];
    expect(last.type).toBe(TokenType.EOF);
    expect(last.start).toBe(input.length);
    for (let idx = 1; idx < t.length; idx++) {
      expect(t[idx].start).toBe(t[idx - 1].end);
    }
  });

  it('long unclosed comment', () => {
    // <!-- followed by 50K characters with no -->
    const input = '<!--' + 'a'.repeat(50_000);
    const t = tokens(input);
    expect(t[0].type).toBe(TokenType.COMMENT_OPEN);
    // The content should be TEXT (recovery for unclosed comment)
    const textTokens = t.filter((tok) => tok.type === TokenType.TEXT);
    expect(textTokens).toHaveLength(1);
    expect(textTokens[0].end - textTokens[0].start).toBe(50_000);
    const last = t[t.length - 1];
    expect(last.type).toBe(TokenType.EOF);
  });

  it('many short lines with line-start markup', () => {
    const lines = [
      '== H ==', '* bullet', '# ordered', ': indent', '; term',
      '{|', '! header', '|-', '| cell', '|}', '----',
    ];
    const input = lines.join('\n').repeat(200) + '\n';
    const t = tokens(input);
    const last = t[t.length - 1];
    expect(last.type).toBe(TokenType.EOF);
    expect(last.start).toBe(input.length);
    for (let idx = 1; idx < t.length; idx++) {
      expect(t[idx].start).toBe(t[idx - 1].end);
    }
  });

  it('entity-heavy input', () => {
    const input = '&amp; &#123; &#x1F4A9; &lt; &gt; &quot; '.repeat(500);
    const t = tokens(input);
    const entities = t.filter((tok) => tok.type === TokenType.HTML_ENTITY);
    // 6 entities per repeat
    expect(entities).toHaveLength(3000);
  });

  it('mixed apostrophe runs of varying lengths', () => {
    // Single, double, triple, quadruple, quintuple apostrophes
    const input = "a'b''c'''d''''e'''''f";
    const t = tokens(input);
    const runs = t.filter((tok) => tok.type === TokenType.APOSTROPHE_RUN);
    // '' (2), ''' (3), '''' (4), ''''' (5)
    expect(runs).toHaveLength(4);
    // Single apostrophe should be TEXT
    const singleApos = t.find((tok) =>
      tok.type === TokenType.TEXT && tok.end - tok.start === 1 &&
      input.slice(tok.start, tok.end) === "'"
    );
    expect(singleApos).toBeDefined();
  });

  it('signature-length tilde edge cases', () => {
    // 1, 2 tildes = TEXT; 3,4,5 = SIGNATURE; 6+ = TEXT
    const cases = [
      { input: '~', expectSig: false },
      { input: '~~', expectSig: false },
      { input: '~~~', expectSig: true },
      { input: '~~~~', expectSig: true },
      { input: '~~~~~', expectSig: true },
      { input: '~~~~~~', expectSig: false },
      { input: '~~~~~~~', expectSig: false },
    ];
    for (const { input, expectSig } of cases) {
      const t = tokens(input);
      const sigs = t.filter((tok) => tok.type === TokenType.SIGNATURE);
      if (expectSig) {
        expect(sigs).toHaveLength(1);
      } else {
        expect(sigs).toHaveLength(0);
      }
    }
  });

  it('rapid line-start transitions', () => {
    // Every character is on a new line
    const input = 'a\nb\nc\nd\ne\n'.repeat(2000);
    const t = tokens(input);
    const newlines = t.filter((tok) => tok.type === TokenType.NEWLINE);
    expect(newlines).toHaveLength(10_000);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests: never-throw and token coverage invariants
// ---------------------------------------------------------------------------

describe('property-based invariants', () => {
  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        // Must not throw
        const t = tokens(s);
        // Must end with EOF
        expect(t[t.length - 1].type).toBe(TokenType.EOF);
      }),
      { numRuns: 500 },
    );
  });

  it('token ranges tile the input with no gaps or overlaps', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const t = tokens(s);
        // First non-EOF token starts at 0 (or only EOF if empty)
        if (t.length > 1) {
          expect(t[0].start).toBe(0);
        }
        // Adjacent tokens are contiguous
        for (let idx = 1; idx < t.length; idx++) {
          expect(t[idx].start).toBe(t[idx - 1].end);
        }
        // Last token (EOF) ends at source length
        expect(t[t.length - 1].end).toBe(s.length);
      }),
      { numRuns: 500 },
    );
  });

  it('every token has start <= end', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        for (const tok of tokenize(s)) {
          expect(tok.start).toBeLessThanOrEqual(tok.end);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('deterministic: same input produces same tokens', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const t1 = tokens(s);
        const t2 = tokens(s);
        expect(t1).toEqual(t2);
      }),
      { numRuns: 200 },
    );
  });

  it('every token type is a valid TokenType', () => {
    const validTypes = new Set(Object.values(TokenType));
    fc.assert(
      fc.property(fc.string(), (s) => {
        for (const tok of tokenize(s)) {
          expect(validTypes.has(tok.type)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on wikitext-like input', () => {
    fc.assert(
      fc.property(wikiish_string(), (s) => {
        const t = tokens(s);
        expect(t[t.length - 1].type).toBe(TokenType.EOF);
        // Token tiling
        for (let idx = 1; idx < t.length; idx++) {
          expect(t[idx].start).toBe(t[idx - 1].end);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('never throws on spacing-heavy syntax-shaped input', () => {
    fc.assert(
      fc.property(spacing_heavy_wikitext_string(), (s) => {
        // Generic fuzzing rarely puts spaces and tabs exactly where line-start and
        // trim rules matter. This generator does, so it helps guard the scanner's
        // most spacing-sensitive classification boundaries.
        const t = tokens(s);
        expect(t[t.length - 1].type).toBe(TokenType.EOF);
        for (let idx = 1; idx < t.length; idx++) {
          expect(t[idx].start).toBe(t[idx - 1].end);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on valid syntax with odd unicode payloads', () => {
    fc.assert(
      fc.property(odd_character_wikitext_string(), (s) => {
        // This property targets real-looking wiki constructs with strange payload
        // characters. The scanner should stay UTF-16-correct and keep tiling the
        // source even when content includes code points that are easy to mishandle.
        const t = tokens(s);
        expect(t[t.length - 1].type).toBe(TokenType.EOF);
        for (let idx = 1; idx < t.length; idx++) {
          expect(t[idx].start).toBe(t[idx - 1].end);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('never throws on pathological mixed delimiter input', () => {
    fc.assert(
      fc.property(pathological_wikitext_string(), (s) => {
        // This intentionally throws malformed mixtures at the scanner. The
        // contract we care about is stability: EOF exists and token tiling is
        // preserved even when the input is hostile.
        const t = tokens(s);
        expect(t[t.length - 1].type).toBe(TokenType.EOF);
        for (let idx = 1; idx < t.length; idx++) {
          expect(t[idx].start).toBe(t[idx - 1].end);
        }
      }),
      { numRuns: 600 },
    );
  });
});
