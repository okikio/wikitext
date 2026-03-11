/**
 * Tests for orchestration and tree-building APIs.
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
import {
  buildTree,
  buildTreeWithDiagnostics,
  buildTreeWithLooseDiagnostics,
  buildTreeWithRecovery,
  type ParseDiagnosticsResult,
  type ParseResult,
} from './tree_builder.ts';
import {
  DiagnosticCode,
  enterEvent,
  errorEvent,
  exitEvent,
  textEvent,
} from './events.ts';
import { blockEvents } from './block_parser.ts';
import { events, outlineEvents, parse, parseWithDiagnostics, parseWithRecovery, tokens } from './parse.ts';
import { tokenize } from './tokenizer.ts';

const COMPLEX_PARSE_FIXTURES = [
  [
    '== Lead ==',
    `A [[Main Page|home]] link with ''italic'' and '''bold'''.`,
    '',
    '* Bullet one',
    '* Bullet two with {{Card|title=Plan|body=value}}',
    '',
    '{|',
    '! Planet !! Notes',
    '|-',
    '| Mars || <ref name="m1">Known as the red planet</ref>',
    '|}',
  ].join('\n'),
  [
    'Paragraph with <nowiki>[[literal]]</nowiki> text and &amp; entity.',
    'Second line keeps the paragraph open until a blank line.',
    '',
    '; Term',
    ': Description with [https://example.com label]',
  ].join('\n'),
] as const;

describe('orchestration', () => {
  it('tokens() aliases the tokenizer output', () => {
    const input = '== Heading ==';
    const direct = Array.from(tokenize(input));
    const orchestrated = Array.from(tokens(input));

    expect(orchestrated).toEqual(direct);
  });

  it('outlineEvents() matches the block parser pipeline', () => {
    const input = '== Heading ==\n\nParagraph';
    const direct = Array.from(blockEvents(input, tokenize(input)));
    const orchestrated = Array.from(outlineEvents(input));

    expect(orchestrated).toEqual(direct);
  });

  it('events() includes inline enrichment', () => {
    const input = 'A [[Page|home]] link';
    const structure = Array.from(events(input))
      .filter((event) => event.kind === 'enter' || event.kind === 'exit')
      .map((event) => event.node_type);

    expect(structure).toContain('wikilink');
  });
});

describe('buildTree()', () => {
  it('treats root enter/exit as document boundaries, not nested nodes', () => {
    const pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 12, offset: 11 },
    } as const;

    const tree = buildTree([
      enterEvent('root', {}, pos),
      enterEvent('paragraph', {}, pos),
      textEvent(0, 5, {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 6, offset: 5 },
      }),
      exitEvent('paragraph', pos),
      exitEvent('root', pos),
    ], { source: 'hello world' });

    expect(tree.type).toBe('root');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].type).toBe('paragraph');
    expect(tree.position).toEqual(pos);
  });

  it('preserves explicit root position even when no child nodes exist', () => {
    const pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    } as const;

    const tree = buildTree([
      enterEvent('root', {}, pos),
      exitEvent('root', pos),
    ], { source: '' });

    expect(tree).toEqual({
      type: 'root',
      children: [],
      position: pos,
    });
  });

  it('materializes literal node values from enter-event props', () => {
    const value_pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 7, offset: 6 },
    } as const;

    const tree = buildTree([
      enterEvent('root', {}, value_pos),
      enterEvent('paragraph', {}, value_pos),
      enterEvent('nowiki', { value: '[[raw]]' }, value_pos),
      exitEvent('nowiki', value_pos),
      enterEvent('comment', { value: ' hidden ' }, value_pos),
      exitEvent('comment', value_pos),
      enterEvent('html-entity', { value: '&amp;' }, value_pos),
      exitEvent('html-entity', value_pos),
      exitEvent('paragraph', value_pos),
      exitEvent('root', value_pos),
    ], { source: 'unused' });

    const paragraph = tree.children[0];
    expect(paragraph.type, 'expected paragraph node in literal materialization test').toBe('paragraph');
    if (paragraph.type !== 'paragraph') return;

    expect(paragraph.children.map((node) => node.type)).toEqual([
      'nowiki',
      'comment',
      'html-entity',
    ]);

    const nowiki = paragraph.children[0];
    const comment = paragraph.children[1];
    const entity = paragraph.children[2];

    expect(nowiki.type, 'expected nowiki node in literal materialization test').toBe('nowiki');
    expect(comment.type, 'expected comment node in literal materialization test').toBe('comment');
    expect(entity.type, 'expected html-entity node in literal materialization test').toBe('html-entity');
    if (nowiki.type !== 'nowiki' || comment.type !== 'comment' || entity.type !== 'html-entity') return;

    expect(nowiki.value).toBe('[[raw]]');
    expect(comment.value).toBe(' hidden ');
    expect(entity.value).toBe('&amp;');
  });

  it('recovers when exits arrive out of order by closing intermediate frames', () => {
    const pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 6, offset: 5 },
    } as const;

    const tree = buildTree([
      enterEvent('root', {}, pos),
      enterEvent('paragraph', {}, pos),
      enterEvent('bold', {}, pos),
      textEvent(0, 5, pos),
      // Intentionally close paragraph first; recovery should still keep
      // a usable tree with bold nested under paragraph.
      exitEvent('paragraph', pos),
      exitEvent('root', pos),
    ], { source: 'hello' });

    expect(tree.children).toHaveLength(1);
    const paragraph = tree.children[0];
    expect(paragraph.type, 'expected paragraph node after out-of-order exit recovery').toBe('paragraph');
    if (paragraph.type !== 'paragraph') return;

    expect(paragraph.children).toHaveLength(1);
    const bold = paragraph.children[0];
    expect(bold.type, 'expected bold child after out-of-order exit recovery').toBe('bold');
    if (bold.type !== 'bold') return;

    expect(bold.children).toHaveLength(1);
    expect(bold.children[0].type).toBe('text');
  });

  it('auto-closes open frames at end of stream using default end points', () => {
    const open_pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 8, offset: 7 },
    } as const;

    const tree = buildTree([
      enterEvent('root', {}, open_pos),
      enterEvent('paragraph', {}, open_pos),
      textEvent(0, 5, {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 6, offset: 5 },
      }),
      // No paragraph exit on purpose.
      exitEvent('root', open_pos),
    ], { source: 'hello??' });

    expect(tree.children).toHaveLength(1);
    const paragraph = tree.children[0];
    expect(paragraph.type, 'expected paragraph node after EOF auto-close').toBe('paragraph');
    if (paragraph.type !== 'paragraph') return;

    expect(paragraph.position).toEqual(open_pos);
    expect(paragraph.children).toHaveLength(1);
    expect(paragraph.children[0].type).toBe('text');
  });

  it('materializes text values from the original source', () => {
    const input = '== Title ==\n\nA [[Page|home]] link';
    const tree = buildTree(events(input), { source: input });

    expect(tree.children[0].type).toBe('heading');
    expect(tree.children[1].type).toBe('paragraph');

    const heading = tree.children[0];
    const paragraph = tree.children[1];

    expect(heading.type, 'expected heading node in materialized tree').toBe('heading');
    expect(paragraph.type, 'expected paragraph node in materialized tree').toBe('paragraph');
    if (heading.type !== 'heading' || paragraph.type !== 'paragraph') return;

    expect(heading.children[0]).toEqual({
      type: 'text',
      value: 'Title',
      position: heading.children[0].position,
    });

    expect(paragraph.children[1].type).toBe('wikilink');
    expect(paragraph.children[1].position).toBeDefined();
  });

  it('builds a block-only tree from outlineEvents(source)', () => {
    const input = '== Title ==\n\nA [[Page|home]] link';
    const tree = buildTree(outlineEvents(input), { source: input });

    expect(tree.children.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
    ]);

    const heading = tree.children[0];
    const paragraph = tree.children[1];

    expect(heading.type, 'expected heading node in outline tree test').toBe('heading');
    expect(paragraph.type, 'expected paragraph node in outline tree test').toBe('paragraph');
    if (heading.type !== 'heading' || paragraph.type !== 'paragraph') return;

    expect(heading.children.map((child) => child.type)).toEqual(['text']);
    expect(paragraph.children.map((child) => child.type)).toEqual(['text']);
    expect(paragraph.children[0]).toEqual({
      type: 'text',
      value: 'A [[Page|home]] link',
      position: paragraph.children[0].position,
    });
  });

  it('ignores token and error events while preserving structural nodes', () => {
    const pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 6, offset: 5 },
    } as const;

    const tree = buildTree([
      enterEvent('paragraph', {}, pos),
      textEvent(0, 5, pos),
      errorEvent('recoverable', pos),
      exitEvent('paragraph', pos),
    ], { source: 'hello' });

    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].type).toBe('paragraph');

    const paragraph = tree.children[0];
    expect(paragraph.type, 'expected paragraph node when ignoring token/error events').toBe('paragraph');
    if (paragraph.type !== 'paragraph') return;

    expect(paragraph.children[0].type).toBe('text');
    if (paragraph.children[0].type !== 'text') {
      expect(paragraph.children[0].type, 'expected text child when ignoring token/error events').toBe('text');
      return;
    }
    expect(paragraph.children[0].value).toBe('hello');
  });

  it('buildTreeWithDiagnostics() preserves event diagnostics with a diagnostic anchor', () => {
    const pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 6, offset: 5 },
    } as const;

    const result = buildTreeWithDiagnostics([
      enterEvent('root', {}, pos),
      enterEvent('paragraph', {}, pos),
      errorEvent('recoverable', pos, {
        severity: 'warning',
        code: 'INLINE_RECOVERY',
        recoverable: true,
        source: 'inline',
      }),
      textEvent(0, 5, pos),
      exitEvent('paragraph', pos),
      exitEvent('root', pos),
    ], { source: 'hello' });

    expect(result.tree.children).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      {
        message: 'recoverable',
        severity: 'warning',
        code: 'INLINE_RECOVERY',
        recoverable: true,
        source: 'inline',
        details: undefined,
        position: pos,
        anchor: {
          kind: 'tree-path',
          path: [0],
          node_type: 'paragraph',
        },
      },
    ]);
  });

  it('buildTreeWithDiagnostics() reports tree-stage recovery locations', () => {
    const pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 6, offset: 5 },
    } as const;

    const result = buildTreeWithDiagnostics([
      enterEvent('root', {}, pos),
      enterEvent('paragraph', {}, pos),
      enterEvent('bold', {}, pos),
      textEvent(0, 5, pos),
      exitEvent('paragraph', pos),
      exitEvent('root', pos),
    ], { source: 'hello' });

    expect(result.tree.children).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.TREE_MISMATCHED_EXIT);
    expect(result.diagnostics[0].anchor).toEqual({
      kind: 'tree-path',
      path: [0, 0],
      node_type: 'text',
    });
    expect(result.diagnostics[0].recoverable).toBe(true);
    expect(result.diagnostics[0].source).toBe('tree');
    expect(result.diagnostics[0].severity).toBe('warning');
  });

  it('buildTreeWithDiagnostics() reports orphan exits at the root boundary', () => {
    const pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    } as const;

    const result = buildTreeWithDiagnostics([
      enterEvent('root', {}, pos),
      exitEvent('italic', pos),
      exitEvent('root', pos),
    ], { source: '' });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.TREE_ORPHAN_EXIT);
    expect(result.diagnostics[0].anchor).toEqual({
      kind: 'tree-path',
      path: [],
      node_type: 'root',
    });
  });

  it('buildTreeWithDiagnostics() reports EOF auto-close recovery for open frames', () => {
    const pos = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 6, offset: 5 },
    } as const;

    const result = buildTreeWithDiagnostics([
      enterEvent('root', {}, pos),
      enterEvent('paragraph', {}, pos),
      textEvent(0, 5, pos),
    ], { source: 'hello' });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.TREE_EOF_AUTOCLOSE);
    expect(result.diagnostics[0].anchor).toEqual({
      kind: 'tree-path',
      path: [0],
      node_type: 'text',
    });
  });

  it('buildTreeWithLooseDiagnostics() keeps the loose tree while preserving diagnostics', () => {
    const input = '{|\n| Cell';
    const loose_result = buildTreeWithLooseDiagnostics(events(input), { source: input });
    const strict_result = buildTreeWithDiagnostics(events(input), { source: input });
    const recovery_result = buildTreeWithRecovery(events(input), { source: input });

    expect(Object.hasOwn(loose_result, 'recovered')).toBe(false);
    expect(loose_result.diagnostics).toEqual(recovery_result.diagnostics);
    expect(loose_result.tree).toEqual(recovery_result.tree);
    expect(loose_result.tree.children[0]?.type).toBe('table');
    expect(strict_result.tree.children[0]?.type).toBe('text');
  });
});

describe('parse()', () => {
  it('builds a usable wikist root', () => {
    const tree = parse("A '''bold''' word");

    expect(tree.type).toBe('root');

    const paragraph = tree.children.find((node) => node.type === 'paragraph');
    expect(paragraph).toBeDefined();

    expect(paragraph?.type, 'expected paragraph node in parsed tree').toBe('paragraph');
    if (paragraph === undefined || paragraph.type !== 'paragraph') return;

    expect(paragraph.children.map((child) => child.type)).toEqual([
      'text',
      'bold',
      'text',
    ]);
  });

  it('matches buildTree(events(source), { source }) on representative mixed inputs', () => {
    for (const input of COMPLEX_PARSE_FIXTURES) {
      expect(parse(input)).toEqual(buildTree(events(input), { source: input }));
    }
  });

  it('builds a full tree with block and inline nodes from a mixed document', () => {
    const input = COMPLEX_PARSE_FIXTURES[0];
    const tree = parse(input);

    expect(tree.children.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'table',
    ]);

    const paragraph = tree.children[1];
    const list = tree.children[2];
    const table = tree.children[3];

    expect(paragraph.type, 'expected paragraph node in mixed parse test').toBe('paragraph');
    expect(list.type, 'expected list node in mixed parse test').toBe('list');
    expect(table.type, 'expected table node in mixed parse test').toBe('table');
    if (paragraph.type !== 'paragraph' || list.type !== 'list' || table.type !== 'table') return;

    expect(paragraph.children.map((child) => child.type)).toEqual([
      'text',
      'wikilink',
      'text',
      'italic',
      'text',
      'bold',
      'text',
    ]);
    expect(list.children).toHaveLength(2);
    expect(list.children[1].type).toBe('list-item');
    expect(table.children.some((child) => child.type === 'table-row')).toBe(true);
  });

  it('preserves representative Unicode text classes through the full pipeline', () => {
    for (const fixture of UNICODE_TEXT_FIXTURES) {
      const input = `== ${fixture.sample} ==\n\n${fixture.sample}`;
      const result = parseWithDiagnostics(input);
      const heading = result.tree.children[0];
      const paragraph = result.tree.children[1];

      expect(result.diagnostics).toEqual([]);
      expect(heading?.type).toBe('heading');
      expect(paragraph?.type).toBe('paragraph');

      if (heading?.type !== 'heading' || paragraph?.type !== 'paragraph') {
        expect(heading?.type, `expected heading node for ${fixture.key}`).toBe('heading');
        expect(paragraph?.type, `expected paragraph node for ${fixture.key}`).toBe('paragraph');
        return;
      }

      expect(heading.children[0]?.type).toBe('text');
      expect(paragraph.children[0]?.type).toBe('text');

      if (heading.children[0]?.type !== 'text' || paragraph.children[0]?.type !== 'text') {
        expect(heading.children[0]?.type, `expected heading text node for ${fixture.key}`).toBe('text');
        expect(paragraph.children[0]?.type, `expected paragraph text node for ${fixture.key}`).toBe('text');
        return;
      }

      expect(heading.children[0].value).toBe(fixture.sample);
      expect(paragraph.children[0].value).toBe(fixture.sample);
    }
  });

  it('preserves literal inline nodes and block structure through the full pipeline', () => {
    const input = COMPLEX_PARSE_FIXTURES[1];
    const tree = parse(input);

    expect(tree.children.map((node) => node.type)).toEqual([
      'paragraph',
      'definition-list',
    ]);

    const paragraph = tree.children[0];
    const definition_list = tree.children[1];

    expect(paragraph.type, 'expected paragraph node in literal parse test').toBe('paragraph');
    expect(definition_list.type, 'expected definition-list node in literal parse test').toBe('definition-list');
    if (paragraph.type !== 'paragraph' || definition_list.type !== 'definition-list') return;

    expect(paragraph.children.map((child) => child.type)).toEqual([
      'text',
      'nowiki',
      'text',
      'html-entity',
      'text',
      'text',
    ]);

    const trailing_text = paragraph.children[5];
    expect(trailing_text?.type, 'expected the second paragraph line to remain a separate text node').toBe('text');
    if (trailing_text?.type !== 'text') return;

    expect(trailing_text.value).toBe('Second line keeps the paragraph open until a blank line.');
    expect(definition_list.children.map((child) => child.type)).toEqual([
      'definition-term',
      'definition-description',
    ]);
  });

  it('keeps a closed reference opener structurally real when the close tag is missing', () => {
    const input = `Paragraph with <ref name="cite-1">''quoted'' and text`;
    const tree = parse(input);
    const paragraph = tree.children[0];

    expect(tree.children.map((node) => node.type)).toEqual(['paragraph']);

    expect(paragraph?.type, 'expected paragraph node in missing-close reference test').toBe('paragraph');
    if (paragraph?.type !== 'paragraph') return;

    expect(paragraph.children.map((child) => child.type)).toEqual([
      'text',
      'reference',
    ]);

    const reference = paragraph.children[1];
    expect(reference?.type, 'expected reference node in missing-close reference test').toBe('reference');
    if (reference?.type !== 'reference') return;

    expect(reference.name).toBe('cite-1');
    expect(JSON.stringify(reference)).toContain('quoted');
  });

  it('keeps an unterminated opener as literal text when `>` never appears', () => {
    const input = 'Paragraph with <ref name="cite-1"';
    const tree = parse(input);
    const paragraph = tree.children[0];

    expect(tree.children.map((node) => node.type)).toEqual(['paragraph']);

    expect(paragraph?.type, 'expected paragraph node in unterminated opener test').toBe('paragraph');
    if (paragraph?.type !== 'paragraph') return;

    expect(paragraph.children.every((child) => child.type === 'text')).toBe(true);
    let combined_text = '';
    for (const child of paragraph.children) {
      if (child.type === 'text') {
        combined_text += child.value;
      }
    }
    expect(combined_text).toBe(input);
  });

  it('never throws and stays equivalent to buildTree(events(source)) on syntax-heavy fuzz input', () => {
    fc.assert(
      fc.property(
        wikiish_string(),
        spacing_heavy_wikitext_string(),
        pathological_wikitext_string(),
        (a: string, b: string, c: string) => {
          const input = `${a}\n${b}\n${c}`;
          const direct = parse(input);
          const layered = buildTree(events(input), { source: input });

          expect(direct.type).toBe('root');
          expect(layered.type).toBe('root');
          expect(direct).toEqual(layered);
        },
      ),
    );
  });

  it('never throws on mixed Unicode and recovery-heavy full-pipeline inputs', () => {
    fc.assert(
      fc.property(
        odd_character_wikitext_string(),
        pathological_wikitext_string(),
        (odd: string, hostile: string) => {
          const input = `${odd}\n${hostile}`;
          const tree = parse(input);

          expect(tree.type).toBe('root');
        },
      ),
    );
  });

  it('keeps Unicode payloads stable inside a representative mixed document', () => {
    for (const fixture of UNICODE_TEXT_FIXTURES) {
      const input = [
        `== ${fixture.sample} ==`,
        `${fixture.sample}`,
        `[[Main Page|${fixture.sample}]]`,
        `{{Card|name=${fixture.sample}}}`,
        '',
      ].join('\n');
      const tree = parse(input);

      expect(tree.type).toBe('root');
      expect(JSON.stringify(tree)).toContain(fixture.sample);
    }
  });
});

describe('parseWithDiagnostics()', () => {
  it('does not expose the recovery summary field', () => {
    const result = parseWithDiagnostics(COMPLEX_PARSE_FIXTURES[0]);

    expect(Object.hasOwn(result, 'recovered')).toBe(false);
  });

  it('preserves the same diagnostics as parseWithRecovery()', () => {
    for (const input of COMPLEX_PARSE_FIXTURES) {
      const diagnostics_result = parseWithDiagnostics(input);
      const recovery_result = parseWithRecovery(input);

      expect(diagnostics_result.diagnostics).toEqual(recovery_result.diagnostics);
    }
  });

  it('returns the same tree as parse() on representative mixed inputs', () => {
    for (const input of COMPLEX_PARSE_FIXTURES) {
      const result = parseWithDiagnostics(input);
      expect(result.tree).toEqual(parse(input));
    }
  });

  it('keeps diagnostics empty when no recovery was needed', () => {
    const result = parseWithDiagnostics(COMPLEX_PARSE_FIXTURES[0]);

    expect(result.diagnostics).toEqual([]);
  });

  it('preserves real parser diagnostics from recovery-heavy input', () => {
    const input = '{|\n| Cell';
    const result = parseWithDiagnostics(input);

    expect(result.tree.type).toBe('root');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.UNCLOSED_TABLE);
    expect(result.diagnostics[0].source).toBe('block');
    expect(result.diagnostics[0].anchor).toEqual({
      kind: 'tree-path',
      path: [0],
      node_type: 'text',
    });
    expect(result.diagnostics[0].recoverable).toBe(true);
    expect(result.diagnostics[0].severity).toBe('warning');
    expect(result.diagnostics[0].position.start.offset).toBe(input.length);
    expect(result.diagnostics[0].position.end.offset).toBe(input.length);
  });

  it('reports a diagnostic when a tag opener never reaches `>`', () => {
    const input = 'Paragraph with <ref name="cite-1"';
    const result = parseWithDiagnostics(input);

    expect(result.tree.type).toBe('root');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.INLINE_TAG_UNTERMINATED_OPENER);
    expect(result.diagnostics[0].source).toBe('inline');
    expect(result.diagnostics[0].recoverable).toBe(true);
    expect(result.diagnostics[0].severity).toBe('warning');
  });

  it('reports a diagnostic when a closed opener never finds its matching close tag', () => {
    const input = 'Paragraph with <ref name="cite-1">note';
    const result = parseWithDiagnostics(input);

    expect(result.tree.type).toBe('root');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.INLINE_TAG_MISSING_CLOSE);
    expect(result.diagnostics[0].source).toBe('inline');
    expect(result.diagnostics[0].recoverable).toBe(true);
    expect(result.diagnostics[0].severity).toBe('warning');
    expect(result.diagnostics[0].anchor.node_type).toBe('text');
  });

  it('keeps the same tree as parse() when no diagnostics were emitted', () => {
    fc.assert(
      fc.property(
        wikiish_string(),
        spacing_heavy_wikitext_string(),
        pathological_wikitext_string(),
        (a: string, b: string, c: string) => {
          const input = `${a}\n${b}\n${c}`;
          const result: ParseDiagnosticsResult = parseWithDiagnostics(input);

          if (result.diagnostics.length === 0) {
            expect(result.tree).toEqual(parse(input));
          }
        },
      ),
    );
  });

  it('keeps missing-close tags as plain text instead of recovered nodes', () => {
    const input = 'Paragraph with <ref name="cite-1">note';
    const result = parseWithDiagnostics(input);

    expect(JSON.stringify(result.tree)).not.toContain('"type":"reference"');
    expect(result.tree.children[0]?.type).toBe('text');
    if (result.tree.children[0]?.type !== 'text') return;
    expect(result.tree.children[0].value).toBe(input);
  });

  it('keeps unclosed tables as plain text instead of recovered table nodes', () => {
    const input = '{|\n| Cell';
    const result = parseWithDiagnostics(input);

    expect(result.tree.children[0]?.type).toBe('text');
    if (result.tree.children[0]?.type !== 'text') return;
    expect(result.tree.children[0].value).toBe(input);
  });
});

describe('parseWithRecovery()', () => {
  it('adds recovery-shaped tree changes on top of parseWithDiagnostics()', () => {
    for (const input of COMPLEX_PARSE_FIXTURES) {
      const diagnostics_result = parseWithDiagnostics(input);
      const recovery_result = parseWithRecovery(input);

      expect(recovery_result.diagnostics).toEqual(diagnostics_result.diagnostics);
      expect(recovery_result.recovered).toBe(diagnostics_result.diagnostics.length > 0);
    }
  });

  it('sets recovered=false when no recovery was needed', () => {
    const result: ParseResult = parseWithRecovery(COMPLEX_PARSE_FIXTURES[0]);

    expect(result.recovered).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it('sets recovered=true when diagnostics were recorded', () => {
    const result: ParseResult = parseWithRecovery('{|\n| Cell');

    expect(result.recovered).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('keeps recovery-specific wrapper nodes that parseWithDiagnostics() strips', () => {
    const input = 'Paragraph with <ref name="cite-1">note';
    const result = parseWithRecovery(input);

    expect(JSON.stringify(result.tree)).toContain('"type":"reference"');
  });
});