/**
 * Tests for inline_parser.ts.
 *
 * Covers the Phase 4 inline-enrichment surface: emphasis, links, templates,
 * arguments, HTML-like inline tags, behavior switches, signatures, entities,
 * and the never-throw / event well-formedness invariants.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';
import * as fc from 'npm:fast-check';

import {
  inlineish_string,
  odd_character_wikitext_string,
  pathological_wikitext_string,
  spacing_heavy_wikitext_string,
} from './_test_utils/arbitraries.ts';
import { tokenize } from './tokenizer.ts';
import { blockEvents } from './block_parser.ts';
import { inlineEvents } from './inline_parser.ts';
import type { EnterEvent, ExitEvent, WikitextEvent } from './events.ts';

function parse(input: string): WikitextEvent[] {
  return [...inlineEvents(input, blockEvents(input, tokenize(input)))];
}

/** Reduce the stream to enter/exit pairs so nesting assertions stay compact. */
function structure(events: WikitextEvent[]): [string, string][] {
  return events
    .filter((event): event is EnterEvent | ExitEvent => event.kind === 'enter' || event.kind === 'exit')
    .map((event) => [event.kind, event.node_type]);
}

/** Find the first enter event for one node type. */
function firstEnter(events: WikitextEvent[], nodeType: string): EnterEvent | undefined {
  return events.find(
    (event): event is EnterEvent => event.kind === 'enter' && event.node_type === nodeType,
  );
}

/** Assert that a given node type appears and return its opening event. */
function expectEnter(events: WikitextEvent[], nodeType: string): EnterEvent {
  const event = firstEnter(events, nodeType);
  expect(event).toBeDefined();
  return event!;
}

/** Resolve text-event ranges back into source strings for content assertions. */
function textValues(events: WikitextEvent[], source: string): string[] {
  return events
    .filter((event) => event.kind === 'text')
    .map((event) => {
      if (event.kind !== 'text') return '';
      return source.slice(event.start_offset, event.end_offset);
    });
}

describe('inlineEvents — emphasis', () => {
  it('parses italic markup', () => {
    const input = "A ''small'' test";
    const events = parse(input);

    expect(structure(events)).toContainEqual(['enter', 'italic']);
    expect(structure(events)).toContainEqual(['exit', 'italic']);
    expect(textValues(events, input)).toContain('small');
  });

  it('parses bold markup', () => {
    const input = "A '''bold''' test";
    const events = parse(input);

    expect(structure(events)).toContainEqual(['enter', 'bold']);
    expect(structure(events)).toContainEqual(['exit', 'bold']);
    expect(textValues(events, input)).toContain('bold');
  });

  it('parses bold-italic markup', () => {
    const input = "A '''''both''''' test";
    const events = parse(input);

    expect(structure(events)).toContainEqual(['enter', 'bold-italic']);
    expect(structure(events)).toContainEqual(['exit', 'bold-italic']);
    expect(textValues(events, input)).toContain('both');
  });

  it('closes unclosed emphasis at end of line', () => {
    const input = "Start ''open\nnext";
    const events = parse(input);

    expect(structure(events)).toContainEqual(['enter', 'italic']);
    expect(structure(events)).toContainEqual(['exit', 'italic']);
    expect(textValues(events, input)).toContain('open');
  });
});

describe('inlineEvents — links', () => {
  it('parses a wikilink with display text', () => {
    const input = 'A [[Main Page|home]] link';
    const events = parse(input);
    const link = expectEnter(events, 'wikilink');

    expect(link.props).toEqual({ target: 'Main Page' });
    expect(textValues(events, input)).toContain('home');
  });

  it('parses an image link by namespace dispatch', () => {
    const input = '[[File:Photo.jpg|thumb|Caption]]';
    const events = parse(input);
    const image = expectEnter(events, 'image-link');

    expect(image.props).toEqual({ target: 'File:Photo.jpg' });
    expect(textValues(events, input)).toContain('thumb|Caption');
  });

  it('keeps leading-colon category links as wikilinks', () => {
    const input = '[[:Category:Science|science]]';
    const events = parse(input);
    const link = expectEnter(events, 'wikilink');

    expect(link.props).toEqual({ target: 'Category:Science' });
  });

  it('parses category links as category-link nodes', () => {
    const input = '[[Category:Physics|Quantum]]';
    const events = parse(input);
    const category = expectEnter(events, 'category-link');

    expect(category.props).toEqual({ target: 'Category:Physics', sort_key: 'Quantum' });
  });

  it('parses bracketed external links', () => {
    const input = '[https://example.com Example]';
    const events = parse(input);
    const link = expectEnter(events, 'external-link');

    expect(link.props).toEqual({ url: 'https://example.com' });
    expect(textValues(events, input)).toContain('Example');
  });

  it('parses bare URLs as external links', () => {
    const input = 'Visit https://example.com now';
    const events = parse(input);
    const link = expectEnter(events, 'external-link');

    expect(link.props).toEqual({ url: 'https://example.com' });
  });

  it('trims wikilink target padding but leaves label spacing untouched', () => {
    const input = '[[  Main Page  |  home  ]]';
    const events = parse(input);
    const link = expectEnter(events, 'wikilink');

    // The target is metadata, so trimming outer padding is reasonable. The label
    // is user-authored inline content, so preserving its interior and outer space
    // is the less surprising behavior. This test documents both halves.

    expect(link.props).toEqual({ target: 'Main Page' });
    expect(textValues(events, input).join('')).toBe('  home  ');
  });

  it('falls back to a bare URL when bracketed external-link syntax starts with a space', () => {
    const input = '[ https://example.com label]';
    const events = parse(input);
    const link = expectEnter(events, 'external-link');

    // This parser is forgiving about many malformed cases. A leading space stops
    // the bracketed-link matcher, but the later bare-URL matcher still recovers
    // the URL inside the brackets. That is worth documenting because it shows the
    // current recovery boundary rather than an idealized stricter grammar.

    expect(link.props).toEqual({ url: 'https://example.com' });
    expect(textValues(events, input).join('')).toContain('[');
    expect(textValues(events, input).join('')).toContain(' label]');
  });

  it('accepts tabs as the separator between an external-link URL and its label', () => {
    const input = '[https://example.com\tLabel]';
    const events = parse(input);
    const link = expectEnter(events, 'external-link');

    // scanUrl stops at tabs and the label skipper accepts tabs as spacing. That is
    // a reasonable convenience boundary for a parser that already treats tabs as
    // general whitespace in other inline contexts.

    expect(link.props).toEqual({ url: 'https://example.com' });
    expect(textValues(events, input).join('')).toBe('Label');
  });
});

describe('inlineEvents — templates and special inline nodes', () => {
  it('parses templates with positional and named arguments', () => {
    const input = '{{Infobox|one|name=value}}';
    const events = parse(input);
    const template = expectEnter(events, 'template');
    const args = events.filter(
      (event): event is EnterEvent => event.kind === 'enter' && event.node_type === 'template-argument',
    );

    expect(template.props).toEqual({ name: 'Infobox' });
    expect(args).toHaveLength(2);
    expect(args[0].props).toEqual({});
    expect(args[1].props).toEqual({ name: 'name' });
    expect(textValues(events, input)).toContain('one');
    expect(textValues(events, input)).toContain('value');
  });

  it('trims template names and named-argument keys around ASCII whitespace', () => {
    const input = '{{  Infobox  | name = value }}';
    const events = parse(input);
    const template = expectEnter(events, 'template');
    const args = events.filter(
      (event): event is EnterEvent => event.kind === 'enter' && event.node_type === 'template-argument',
    );

    // Template heads and named arguments are structural fields, so trimming ASCII
    // padding around them makes the parser more forgiving without rewriting the
    // actual argument value payload.

    expect(template.props).toEqual({ name: 'Infobox' });
    expect(args[0].props).toEqual({ name: 'name' });
    expect(textValues(events, input).join('')).toContain(' value ');
  });

  it('parses parser functions by # prefix', () => {
    const input = '{{#if:cond|yes|no}}';
    const events = parse(input);
    const fn = expectEnter(events, 'parser-function');

    expect(fn.props).toEqual({ name: '#if:cond' });
  });

  it('parses triple-brace arguments', () => {
    const input = '{{{title|Untitled}}}';
    const events = parse(input);
    const arg = expectEnter(events, 'argument');

    expect(arg.props).toEqual({ name: 'title', default: 'Untitled' });
  });

  it('parses behavior switches', () => {
    const input = '__TOC__';
    const events = parse(input);
    const sw = expectEnter(events, 'behavior-switch');

    expect(sw.props).toEqual({ name: 'TOC' });
  });

  it('parses behavior switches with internal underscores', () => {
    const input = '__CUSTOM_EXT__';
    const events = parse(input);
    const sw = expectEnter(events, 'behavior-switch');

    expect(sw.props).toEqual({ name: 'CUSTOM_EXT' });
  });

  it('leaves unclosed behavior-switch text alone', () => {
    const input = '__TOC_';
    const events = parse(input);

    expect(firstEnter(events, 'behavior-switch')).toBeUndefined();
    expect(textValues(events, input)).toContain('__TOC_');
  });

  it('parses signatures', () => {
    const input = '~~~~';
    const events = parse(input);
    const sig = expectEnter(events, 'signature');

    expect(sig.props).toEqual({ tildes: 4 });
  });

  it('parses HTML entities', () => {
    const input = '&amp;';
    const events = parse(input);
    const entity = expectEnter(events, 'html-entity');

    expect(entity.props).toEqual({ value: '&amp;' });
  });

  it('parses comments as comment nodes', () => {
    const input = 'A <!--hidden--> note';
    const events = parse(input);
    const comment = expectEnter(events, 'comment');

    expect(comment.props).toEqual({ value: 'hidden' });
  });

  it('parses <br> as break nodes', () => {
    const input = 'Line<br/>Break';
    const events = parse(input);

    expect(structure(events)).toContainEqual(['enter', 'break']);
    expect(structure(events)).toContainEqual(['exit', 'break']);
  });

  it('parses nowiki content without inline expansion', () => {
    const input = 'A <nowiki>[[Not a link]]</nowiki> test';
    const events = parse(input);
    const nowiki = expectEnter(events, 'nowiki');

    expect(nowiki.props).toEqual({ value: '[[Not a link]]' });
    expect(firstEnter(events, 'wikilink')).toBeUndefined();
  });

  it('parses references with attributes and inline children', () => {
    const input = `<ref name="cite-1" group="note">''quoted''</ref>`;
    const events = parse(input);
    const reference = expectEnter(events, 'reference');

    expect(reference.props).toEqual({ name: 'cite-1', group: 'note' });
    expect(structure(events)).toContainEqual(['enter', 'italic']);
    expect(textValues(events, input)).toContain('quoted');
  });

  it('parses generic HTML tags with children and attributes', () => {
    const input = `<span class="lead">''hi''</span>`;
    const events = parse(input);
    const tag = expectEnter(events, 'html-tag');

    expect(tag.props).toEqual({
      tag_name: 'span',
      self_closing: false,
      attributes: { class: 'lead' },
    });
    expect(structure(events)).toContainEqual(['enter', 'italic']);
  });

  it('parses self-closing generic HTML tags', () => {
    const input = 'A <span class="lead"/> test';
    const events = parse(input);
    const tag = expectEnter(events, 'html-tag');

    expect(tag.props).toEqual({
      tag_name: 'span',
      self_closing: true,
      attributes: { class: 'lead' },
    });
  });

  it('handles highly mixed inline markup without losing nested structure', () => {
    const input = `[[File:Example.jpg|thumb|{{Card|name=[[Main Page|home]]}} <ref name="n">''quoted'' &amp;</ref>]]`;
    const events = parse(input);

    expectEnter(events, 'image-link');
    expectEnter(events, 'template');
    expectEnter(events, 'wikilink');
    expectEnter(events, 'reference');
    expectEnter(events, 'italic');
    expectEnter(events, 'html-entity');
  });

  it('does not invent external links for bracketed non-url text', () => {
    const input = '[not-a-url label]';
    const events = parse(input);

    // Brackets alone are not enough to justify an external-link node. If the
    // leading payload is not a URL, preserving the original text is safer than
    // guessing a link shape the source never actually had.

    expect(firstEnter(events, 'external-link')).toBeUndefined();
    expect(textValues(events, input).join('')).toBe(input);
  });

  it('handles deeply mixed supported markup while leaving markdown fences literal', () => {
    const input = '[[Live|link]] {{Card|body=<span>\'\'ok\'\'</span>}} ```md\n'
      + 'literal [[Literal]] {{Literal|x}}\n'
      + 'plain marker * not-a-list\n'
      + '```';
    const events = parse(input);
    const html = expectEnter(events, 'html-tag');

    // This is a workflow-style stress case: live wikilinks, templates, HTML,
    // apostrophe formatting, and unsupported markdown fences in one span. The
    // parser should recognize the wikitext/HTML constructs it knows and leave
    // the markdown fence text alone instead of inventing a separate mode.

    expect(html.props).toEqual({
      tag_name: 'span',
      self_closing: false,
    });
    expectEnter(events, 'wikilink');
    expectEnter(events, 'template');
    expect(structure(events)).toContainEqual(['enter', 'italic']);
    expect(textValues(events, input).join('')).toContain('```md');
  });

  it('keeps unsupported markdown code fences as ordinary text outside nowiki', () => {
    const input = '```md\n[[Still parsed by wikitext stages as normal text context trigger]]\n```';
    const events = parse(input);

    // Outside a real nowiki-like escape hatch, unsupported markdown syntax is
    // still just text. This expectation protects against accidental feature
    // creep where backticks silently change parser mode.

    expect(textValues(events, input).join('')).toContain('```md');
  });

  it('parses valid inline constructs even when their payload contains odd unicode characters', () => {
    const input = '[[Cafe\u0301|caf\u00E9]] {{Card|name=Zo\u200Be}} <span data-note="\u2603">ok</span>';
    const events = parse(input);
    const link = expectEnter(events, 'wikilink');
    const template = expectEnter(events, 'template');
    const html = expectEnter(events, 'html-tag');

    // These are still valid constructs because the delimiters are ordinary and
    // balanced. The parser should remain forgiving when the payload text is odd,
    // and it should preserve those code points rather than normalizing them away.

    expect(link.props).toEqual({ target: 'Cafe\u0301' });
    expect(template.props).toEqual({ name: 'Card' });
    expect(html.props).toEqual({
      tag_name: 'span',
      self_closing: false,
      attributes: { 'data-note': '\u2603' },
    });
    expect(textValues(events, input).join('')).toContain('caf\u00E9');
    expect(textValues(events, input).join('')).toContain('Zo\u200Be');
  });

  it('does not treat backslashes as a general inline escape hatch for delimiters', () => {
    const input = '\\[[Main Page|home]] \\{{Card|name=value}} \\&amp;';
    const events = parse(input);

    // The current inline parser does not have markdown-style backslash escaping.
    // These tests document the real expectation: the backslash survives as text,
    // and the delimiter after it is still eligible for normal parsing. That is
    // necessary to state explicitly because many readers would otherwise assume
    // `\[` or `\{` suppresses syntax here.

    expectEnter(events, 'wikilink');
    expectEnter(events, 'template');
    expectEnter(events, 'html-entity');
    expect(textValues(events, input).join('')).toContain('\\');
  });
});

describe('inlineEvents — invariants', () => {
  it('never throws for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => parse(input)).not.toThrow();
      }),
    );
  });

  it('keeps enter and exit events well-formed', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const events = parse(input);
        const stack: string[] = [];

        for (const event of events) {
          if (event.kind === 'enter') {
            stack.push(event.node_type);
            continue;
          }
          if (event.kind === 'exit') {
            const open = stack.pop();
            expect(open).toBe(event.node_type);
          }
        }

        expect(stack).toHaveLength(0);
      }),
    );
  });

  it('keeps text ranges and positions valid on wikitext-shaped input', () => {
    fc.assert(
      fc.property(inlineish_string(), (input) => {
        const events = parse(input);

        for (const event of events) {
          if (event.kind === 'text') {
            expect(event.start_offset).toBeGreaterThanOrEqual(0);
            expect(event.end_offset).toBeGreaterThanOrEqual(event.start_offset);
            expect(event.end_offset).toBeLessThanOrEqual(input.length);
            expect(event.position.start.offset).toBe(event.start_offset);
            expect(event.position.end.offset).toBe(event.end_offset);
          }

          if (event.kind === 'enter' || event.kind === 'exit') {
            expect(event.position.start.offset).toBeGreaterThanOrEqual(0);
            expect(event.position.end.offset).toBeGreaterThanOrEqual(event.position.start.offset);
            expect(event.position.end.offset).toBeLessThanOrEqual(input.length);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it('keeps spacing-heavy inline input balanced', () => {
    fc.assert(
      fc.property(spacing_heavy_wikitext_string(), (input) => {
        // These examples place spaces at the exact edges where inline parsing trims,
        // splits, or refuses to match. That makes them a better stress case for the
        // current inline rules than a generic arbitrary string.
        const events = parse(input);
        const stack: string[] = [];

        for (const event of events) {
          if (event.kind === 'enter') {
            stack.push(event.node_type);
            continue;
          }
          if (event.kind === 'exit') {
            const open = stack.pop();
            expect(open).toBe(event.node_type);
          }
        }

        expect(stack).toHaveLength(0);
      }),
      { numRuns: 400 },
    );
  });

  it('keeps valid odd-unicode inline input balanced and in-bounds', () => {
    fc.assert(
      fc.property(odd_character_wikitext_string(), (input) => {
        // These inputs stay close to valid authored markup while injecting odd code
        // points into content. The current parser should remain recoverable and keep
        // every reported range inside the source bounds.
        const events = parse(input);
        const stack: string[] = [];

        for (const event of events) {
          if (event.kind === 'enter') stack.push(event.node_type);
          else if (event.kind === 'exit') {
            const open = stack.pop();
            expect(open).toBe(event.node_type);
          }

          if (event.kind === 'text') {
            expect(event.start_offset).toBeGreaterThanOrEqual(0);
            expect(event.end_offset).toBeLessThanOrEqual(input.length);
          }
        }

        expect(stack).toHaveLength(0);
      }),
      { numRuns: 300 },
    );
  });

  it('keeps enter and exit events balanced on pathological mixed input', () => {
    fc.assert(
      fc.property(pathological_wikitext_string(), (input) => {
        // Inline recovery can choose many conservative outputs, but it must not
        // produce broken nesting. Balance is the core contract that downstream
        // consumers rely on.
        const events = parse(input);
        const stack: string[] = [];

        for (const event of events) {
          if (event.kind === 'enter') {
            stack.push(event.node_type);
            continue;
          }
          if (event.kind === 'exit') {
            const open = stack.pop();
            expect(open).toBe(event.node_type);
          }
        }

        expect(stack).toHaveLength(0);
      }),
      { numRuns: 400 },
    );
  });
});