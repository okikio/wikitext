/**
 * Tests for block_parser.ts.
 *
 * Verifies block-level event emission for headings, paragraphs, lists,
 * definition lists, tables, thematic breaks, and preformatted blocks.
 * Includes property-based fuzz tests for never-throw and event
 * well-formedness invariants.
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
import { tokenize } from './tokenizer.ts';
import { blockEvents } from './block_parser.ts';
import type { WikitextEvent, EnterEvent, ExitEvent } from './events.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all events from blockEvents into an array. */
function parse(input: string): WikitextEvent[] {
  return [...blockEvents(input, tokenize(input))];
}

/**
 * Extract only enter/exit events as `[kind, node_type]` tuples.
 *
 * Most block parser assertions care about nesting shape, not exact offsets, so
 * this helper strips the stream down to the structural signal under test.
 */
function structure(events: WikitextEvent[]): [string, string][] {
  return events
    .filter((e): e is EnterEvent | ExitEvent => e.kind === 'enter' || e.kind === 'exit')
    .map((e) => [e.kind, e.node_type]);
}

/** Recover source slices for text events so content assertions stay readable. */
function textContent(events: WikitextEvent[], source: string): string[] {
  return events
    .filter((e) => e.kind === 'text')
    .map((e) => {
      if (e.kind !== 'text') return '';
      return source.slice(e.start_offset, e.end_offset);
    });
}

/** Read the props from the first enter event of a given node type. */
function firstProps(events: WikitextEvent[], nodeType: string): Record<string, unknown> {
  const enter = events.find(
    (e): e is EnterEvent => e.kind === 'enter' && e.node_type === nodeType,
  );
  return enter ? { ...enter.props } : {};
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

describe('blockEvents — headings', () => {
  it('parses a level 2 heading', () => {
    const input = '== Title ==';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toEqual([
      ['enter', 'root'],
      ['enter', 'heading'],
      ['exit', 'heading'],
      ['exit', 'root'],
    ]);
    expect(firstProps(events, 'heading')).toEqual({ level: 2 });
    expect(textContent(events, input)).toEqual(['Title']);
  });

  it('parses heading levels 1 through 6', () => {
    for (let level = 1; level <= 6; level++) {
      const marker = '='.repeat(level);
      const input = `${marker} H ${marker}`;
      const events = parse(input);
      expect(firstProps(events, 'heading')).toEqual({ level });
    }
  });

  it('caps heading level at 6', () => {
    const input = '======= Too deep =======';
    const events = parse(input);
    expect(firstProps(events, 'heading')).toEqual({ level: 6 });
  });

  it('handles heading without close marker', () => {
    const input = '== Open heading';
    const events = parse(input);
    const struct = structure(events);
    expect(struct).toContainEqual(['enter', 'heading']);
    expect(struct).toContainEqual(['exit', 'heading']);
    expect(textContent(events, input).join('')).toContain('Open');
  });

  it('handles heading followed by paragraph', () => {
    const input = '== Title ==\nBody text';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toEqual([
      ['enter', 'root'],
      ['enter', 'heading'],
      ['exit', 'heading'],
      ['enter', 'paragraph'],
      ['exit', 'paragraph'],
      ['exit', 'root'],
    ]);
  });

  it('handles multiple headings', () => {
    const input = '== First ==\n== Second ==';
    const events = parse(input);
    const headings = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'heading',
    );
    expect(headings.length).toBe(2);
  });

  it('trims only the outer heading padding while preserving internal spacing', () => {
    const input = '==  spaced  title  ==';
    const events = parse(input);

    // Heading parsing is intentionally forgiving about extra outer spaces, but it
    // should not normalize away the author's internal text spacing. This test
    // captures that exact boundary so later cleanup work does not silently turn
    // heading parsing into a content rewriter.

    expect(textContent(events, input).join('')).toBe('spaced  title');
  });
});

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

describe('blockEvents — paragraphs', () => {
  it('parses a simple paragraph', () => {
    const input = 'Hello world';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toEqual([
      ['enter', 'root'],
      ['enter', 'paragraph'],
      ['exit', 'paragraph'],
      ['exit', 'root'],
    ]);
    expect(textContent(events, input).join('')).toContain('Hello');
  });

  it('handles multi-line paragraph', () => {
    const input = 'Line one\nLine two';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toEqual([
      ['enter', 'root'],
      ['enter', 'paragraph'],
      ['exit', 'paragraph'],
      ['exit', 'root'],
    ]);
  });

  it('ends paragraph at blank line', () => {
    const input = 'Para one\n\nPara two';
    const events = parse(input);
    const paras = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'paragraph',
    );
    expect(paras.length).toBe(2);
  });

  it('ends paragraph before heading', () => {
    const input = 'Some text\n== Heading ==';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toEqual([
      ['enter', 'root'],
      ['enter', 'paragraph'],
      ['exit', 'paragraph'],
      ['enter', 'heading'],
      ['exit', 'heading'],
      ['exit', 'root'],
    ]);
  });

  it('does not emit empty paragraph for blank input', () => {
    const events = parse('');
    const struct = structure(events);
    expect(struct).toEqual([
      ['enter', 'root'],
      ['exit', 'root'],
    ]);
  });

  it('does not emit empty paragraph for whitespace-only input', () => {
    const events = parse('\n\n\n');
    const paras = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'paragraph',
    );
    expect(paras.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bullet lists
// ---------------------------------------------------------------------------

describe('blockEvents — bullet lists', () => {
  it('parses a single bullet item', () => {
    const input = '* Item';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'list']);
    expect(struct).toContainEqual(['enter', 'list-item']);
    expect(struct).toContainEqual(['exit', 'list-item']);
    expect(struct).toContainEqual(['exit', 'list']);
    expect(firstProps(events, 'list')).toEqual({ ordered: false });
  });

  it('parses two bullet items', () => {
    const input = '* A\n* B';
    const events = parse(input);
    const items = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'list-item',
    );
    expect(items.length).toBe(2);
  });

  it('parses nested bullet list', () => {
    const input = '* A\n** B';
    const events = parse(input);
    const lists = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'list',
    );
    // Outer list and nested inner list.
    expect(lists.length).toBe(2);
  });

  it('emits list item content as text', () => {
    const input = '* Hello';
    const events = parse(input);
    expect(textContent(events, input).join('')).toContain('Hello');
  });
});

// ---------------------------------------------------------------------------
// Ordered lists
// ---------------------------------------------------------------------------

describe('blockEvents — ordered lists', () => {
  it('parses a single ordered item', () => {
    const input = '# Item';
    const events = parse(input);
    expect(firstProps(events, 'list')).toEqual({ ordered: true });
  });

  it('parses nested ordered list', () => {
    const input = '# A\n## B';
    const events = parse(input);
    const lists = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'list',
    );
    expect(lists.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Definition lists
// ---------------------------------------------------------------------------

describe('blockEvents — definition lists', () => {
  it('parses a definition term', () => {
    const input = '; Term';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'definition-list']);
    expect(struct).toContainEqual(['enter', 'definition-term']);
    expect(struct).toContainEqual(['exit', 'definition-term']);
    expect(struct).toContainEqual(['exit', 'definition-list']);
  });

  it('parses a definition description', () => {
    const input = ': Description';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'definition-list']);
    expect(struct).toContainEqual(['enter', 'definition-description']);
    expect(struct).toContainEqual(['exit', 'definition-description']);
    expect(struct).toContainEqual(['exit', 'definition-list']);
  });

  it('parses term followed by description', () => {
    const input = '; Term\n: Description';
    const events = parse(input);
    const terms = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'definition-term',
    );
    const descs = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'definition-description',
    );
    expect(terms.length).toBe(1);
    expect(descs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

describe('blockEvents — tables', () => {
  it('parses a minimal table', () => {
    const input = '{|\n|}';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'table']);
    expect(struct).toContainEqual(['exit', 'table']);
  });

  it('parses table with attributes', () => {
    const input = '{| class="wikitable"\n|}';
    const events = parse(input);
    expect(firstProps(events, 'table'))
      .toEqual({ attributes: 'class="wikitable"' });
  });

  it('parses table with a data cell', () => {
    const input = '{|\n| Cell content\n|}';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'table-row']);
    expect(struct).toContainEqual(['enter', 'table-cell']);
    expect(struct).toContainEqual(['exit', 'table-cell']);
    expect(struct).toContainEqual(['exit', 'table-row']);
    expect(firstProps(events, 'table-cell')).toEqual({ header: false });
  });

  it('parses table with header cells', () => {
    const input = '{|\n! Header\n|}';
    const events = parse(input);
    expect(firstProps(events, 'table-cell')).toEqual({ header: true });
  });

  it('parses table with inline cell separators ||', () => {
    const input = '{|\n| A || B\n|}';
    const events = parse(input);
    const cells = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'table-cell',
    );
    expect(cells.length).toBe(2);
  });

  it('parses table with inline header separators !!', () => {
    const input = '{|\n! A !! B\n|}';
    const events = parse(input);
    const cells = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'table-cell',
    );
    expect(cells.length).toBe(2);
  });

  it('parses table with explicit row separator', () => {
    const input = '{|\n| A\n|-\n| B\n|}';
    const events = parse(input);
    const rows = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'table-row',
    );
    expect(rows.length).toBe(2);
  });

  it('parses table caption', () => {
    const input = '{|\n|+ My caption\n| Cell\n|}';
    const events = parse(input);
    const struct = structure(events);
    expect(struct).toContainEqual(['enter', 'table-caption']);
    expect(struct).toContainEqual(['exit', 'table-caption']);
  });

  it('recovers from unclosed table', () => {
    const input = '{|\n| Cell';
    const events = parse(input);
    const errors = events.filter((e) => e.kind === 'error');

    // A malformed table still needs a balanced table envelope so downstream
    // consumers do not inherit broken nesting on top of the original syntax
    // problem.

    expect(errors.length).toBeGreaterThan(0);
    // Table still has enter and exit.
    const struct = structure(events);
    expect(struct).toContainEqual(['enter', 'table']);
    expect(struct).toContainEqual(['exit', 'table']);
  });
});

// ---------------------------------------------------------------------------
// Thematic breaks
// ---------------------------------------------------------------------------

describe('blockEvents — thematic breaks', () => {
  it('parses a thematic break', () => {
    const input = '----';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'thematic-break']);
    expect(struct).toContainEqual(['exit', 'thematic-break']);
  });

  it('parses thematic break between paragraphs', () => {
    const input = 'Above\n----\nBelow';
    const events = parse(input);
    const struct = structure(events);

    // The thematic break token is emitted by the tokenizer only at line
    // start, so the paragraph parser will see "Above" and then the
    // THEMATIC_BREAK token starts a new block.
    expect(struct).toContainEqual(['enter', 'thematic-break']);
    expect(struct).toContainEqual(['exit', 'thematic-break']);
  });
});

// ---------------------------------------------------------------------------
// Preformatted blocks
// ---------------------------------------------------------------------------

describe('blockEvents — preformatted blocks', () => {
  it('parses a single preformatted line', () => {
    const input = ' code line';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'preformatted']);
    expect(struct).toContainEqual(['exit', 'preformatted']);
  });

  it('merges consecutive preformatted lines', () => {
    const input = ' line 1\n line 2';
    const events = parse(input);
    // Only one preformatted block.
    const prefs = events.filter(
      (e): e is EnterEvent => e.kind === 'enter' && e.node_type === 'preformatted',
    );
    expect(prefs.length).toBe(1);
  });

  it('ends preformatted block at non-space line', () => {
    const input = ' code\nNot code';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'preformatted']);
    expect(struct).toContainEqual(['exit', 'preformatted']);
    expect(struct).toContainEqual(['enter', 'paragraph']);
    expect(struct).toContainEqual(['exit', 'paragraph']);
  });
});

// ---------------------------------------------------------------------------
// Mixed blocks
// ---------------------------------------------------------------------------

describe('blockEvents — mixed blocks', () => {
  it('handles heading, paragraph, list, thematic break in sequence', () => {
    const input = '== Title ==\nText\n* Item\n----';
    const events = parse(input);
    const struct = structure(events);

    // All block types present.
    expect(struct).toContainEqual(['enter', 'heading']);
    expect(struct).toContainEqual(['enter', 'paragraph']);
    expect(struct).toContainEqual(['enter', 'list']);
    expect(struct).toContainEqual(['enter', 'thematic-break']);
  });

  it('handles table followed by paragraph', () => {
    const input = '{|\n| Cell\n|}\nAfter table';
    const events = parse(input);
    const struct = structure(events);

    expect(struct).toContainEqual(['enter', 'table']);
    expect(struct).toContainEqual(['exit', 'table']);
    expect(struct).toContainEqual(['enter', 'paragraph']);
    expect(struct).toContainEqual(['exit', 'paragraph']);
  });
});

// ---------------------------------------------------------------------------
// Root wrapping
// ---------------------------------------------------------------------------

describe('blockEvents — root', () => {
  it('wraps all output in root enter/exit', () => {
    const events = parse('text');
    expect(events[0]).toMatchObject({ kind: 'enter', node_type: 'root' });
    expect(events[events.length - 1]).toMatchObject({ kind: 'exit', node_type: 'root' });
  });

  it('wraps empty input in root enter/exit', () => {
    const events = parse('');
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ kind: 'enter', node_type: 'root' });
    expect(events[1]).toMatchObject({ kind: 'exit', node_type: 'root' });
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('blockEvents — property-based', () => {
  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const events = parse(s);
        expect(events.length).toBeGreaterThanOrEqual(2); // at least root enter/exit
      }),
      { numRuns: 500 },
    );
  });

  it('event well-formedness: enter/exit pairs are balanced', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const events = parse(s);
        const stack: string[] = [];

        for (const evt of events) {
          if (evt.kind === 'enter') {
            stack.push(evt.node_type);
          } else if (evt.kind === 'exit') {
            const top = stack.pop();
            expect(top).toBe(evt.node_type);
          }
        }

        // Stack must be empty after all events.
        expect(stack.length).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it('root is always the outermost enter/exit', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const events = parse(s);
        const enters = events.filter((e) => e.kind === 'enter');
        const exits = events.filter((e) => e.kind === 'exit');

        if (enters.length > 0) {
          expect((enters[0] as EnterEvent).node_type).toBe('root');
        }
        if (exits.length > 0) {
          expect((exits[exits.length - 1] as ExitEvent).node_type).toBe('root');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('wikitext-shaped input produces valid events', () => {
    fc.assert(
      fc.property(wikiish_string(), (s) => {
        const events = parse(s);
        const stack: string[] = [];
        for (const evt of events) {
          if (evt.kind === 'enter') stack.push(evt.node_type);
          else if (evt.kind === 'exit') {
            const top = stack.pop();
            expect(top).toBe(evt.node_type);
          }
        }
        expect(stack.length).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it('spacing-heavy inputs still produce balanced block events', () => {
    fc.assert(
      fc.property(spacing_heavy_wikitext_string(), (s) => {
        // Block parsing is where spacing matters most because line-start markers,
        // blank lines, and preformatted lines all compete. This property checks
        // that those decisions stay recoverable instead of corrupting nesting.
        const events = parse(s);
        const stack: string[] = [];

        for (const evt of events) {
          if (evt.kind === 'enter') stack.push(evt.node_type);
          else if (evt.kind === 'exit') {
            const top = stack.pop();
            expect(top).toBe(evt.node_type);
          }
        }

        expect(stack).toHaveLength(0);
      }),
      { numRuns: 400 },
    );
  });

  it('valid syntax with odd unicode payloads still produces balanced block events', () => {
    fc.assert(
      fc.property(odd_character_wikitext_string(), (s) => {
        // These inputs are mostly valid constructs with strange payload text. The
        // block parser should remain forgiving because delimiter placement stays
        // sane even when the content inside those blocks is unusual.
        const events = parse(s);
        const stack: string[] = [];

        for (const evt of events) {
          if (evt.kind === 'enter') stack.push(evt.node_type);
          else if (evt.kind === 'exit') {
            const top = stack.pop();
            expect(top).toBe(evt.node_type);
          }
        }

        expect(stack).toHaveLength(0);
      }),
      { numRuns: 300 },
    );
  });

  it('pathological mixed input still produces balanced block events', () => {
    fc.assert(
      fc.property(pathological_wikitext_string(), (s) => {
        // The block parser is allowed to recover conservatively, but it is not
        // allowed to break stack discipline. Even ugly mixed input must still
        // yield a usable enter/exit structure.
        const events = parse(s);
        const stack: string[] = [];

        for (const evt of events) {
          if (evt.kind === 'enter') stack.push(evt.node_type);
          else if (evt.kind === 'exit') {
            const top = stack.pop();
            expect(top).toBe(evt.node_type);
          }
        }

        expect(stack).toHaveLength(0);
      }),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('blockEvents — edge cases', () => {
  it('handles single newline', () => {
    const events = parse('\n');
    const struct = structure(events);
    expect(struct).toEqual([
      ['enter', 'root'],
      ['exit', 'root'],
    ]);
  });

  it('handles only whitespace', () => {
    // Leading space is PREFORMATTED_MARKER
    const events = parse(' ');
    const struct = structure(events);
    expect(struct).toContainEqual(['enter', 'preformatted']);
    expect(struct).toContainEqual(['exit', 'preformatted']);
  });

  it('handles bare list markers without content', () => {
    const events = parse('*');
    const struct = structure(events);
    expect(struct).toContainEqual(['enter', 'list']);
    expect(struct).toContainEqual(['exit', 'list']);
  });

  it('handles bare heading marker', () => {
    const events = parse('==');
    const struct = structure(events);
    expect(struct).toContainEqual(['enter', 'heading']);
    expect(struct).toContainEqual(['exit', 'heading']);
  });

  it('handles \\r\\n line endings', () => {
    const input = '== H ==\r\nText';
    const events = parse(input);
    const struct = structure(events);
    expect(struct).toContainEqual(['enter', 'heading']);
    expect(struct).toContainEqual(['enter', 'paragraph']);
  });

  it('handles bare \\r line endings', () => {
    const input = '== H ==\rText';
    const events = parse(input);
    const struct = structure(events);
    expect(struct).toContainEqual(['enter', 'heading']);
    expect(struct).toContainEqual(['enter', 'paragraph']);
  });

  it('treats a leading space before heading syntax as preformatted instead of heading markup', () => {
    const input = ' == Not a heading ==';
    const events = parse(input);
    const struct = structure(events);

    // At block level, column 0 matters. A single leading space changes the line
    // into preformatted content, so the parser should not reinterpret the later
    // equals signs as a heading opener after that decision has already been made.

    expect(struct).toContainEqual(['enter', 'preformatted']);
    expect(struct).not.toContainEqual(['enter', 'heading']);
  });

  it('treats a leading backslash before block delimiters as literal paragraph text', () => {
    const input = '\\== Not a heading ==\n\\* not a list item';
    const events = parse(input);
    const struct = structure(events);
    const text = textContent(events, input).join('');

    // The parser has no generic backslash-escape mode. The important current
    // behavior is simpler: the backslash becomes real content at column 0, so the
    // later `==` and `*` no longer sit at a block-start position. This is a
    // reasonable test because block parsing here is position-driven, not escape-
    // driven.

    expect(struct).toContainEqual(['enter', 'paragraph']);
    expect(struct).not.toContainEqual(['enter', 'heading']);
    expect(struct).not.toContainEqual(['enter', 'list']);
    expect(text).toContain('\\== Not a heading ==');
    expect(text).toContain('\\* not a list item');
  });

  it('treats markdown fenced code blocks as ordinary paragraph text', () => {
    const input = '```md\n[[Not a link]]\n{{NotATemplate}}\n```';
    const events = parse(input);
    const struct = structure(events);

    // Fenced code blocks are markdown syntax, not wikitext syntax. Since this
    // parser does not implement markdown mode switching, the reasonable block
    // behavior is to leave the content in an ordinary paragraph.

    expect(struct).toContainEqual(['enter', 'paragraph']);
    expect(struct).not.toContainEqual(['enter', 'preformatted']);
    expect(textContent(events, input).join('')).toContain('```md');
  });

  it('keeps valid block structure when text payload contains odd unicode characters', () => {
    const input = '== Caf\u0301e\u2060Title ==\n* item \u{1F9EA}';
    const events = parse(input);
    const struct = structure(events);
    const text = textContent(events, input).join('');

    // These characters are unusual, but the surrounding wikitext is valid. The
    // parser should still recover the same block shapes because odd payload text
    // is content, not a reason to abandon heading or list recognition.

    expect(struct).toContainEqual(['enter', 'heading']);
    expect(struct).toContainEqual(['enter', 'list']);
    expect(text).toContain('\u2060');
    expect(text).toContain('\u{1F9EA}');
  });
});
