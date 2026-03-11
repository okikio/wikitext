/**
 * Tests for filter.ts.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';

import {
  collectEvents,
  filter,
  filterCategories,
  filterEvents,
  filterLinks,
  filterTemplates,
  locateDiagnostic,
  matches,
  resolveDiagnosticAnchor,
  resolveTreePath,
  visit,
} from './filter.ts';
import { events, parse, parseWithDiagnostics } from './parse.ts';
import { categoryLink, heading, paragraph, root, template, text, wikilink } from './ast.ts';

describe('filter()', () => {
  it('collects nodes by type', () => {
    const tree = root([
      heading(2, [text('Title')]),
      paragraph([wikilink('Page', [text('home')])]),
    ]);

    expect(filter(tree, 'heading')).toHaveLength(1);
    expect(filterLinks(tree)).toHaveLength(1);
  });

  it('exposes convenience filters', () => {
    const tree = root([
      paragraph([template('Infobox', [])]),
      categoryLink('Science', 'Physics'),
    ]);

    expect(filterTemplates(tree)).toHaveLength(1);
    expect(filterCategories(tree)).toHaveLength(1);
  });
});

describe('visit()', () => {
  it('walks the tree in pre-order', () => {
    const tree = parse('== Title ==\n\nText');
    const types: string[] = [];

    visit(tree, (node) => {
      types.push(node.type);
    });

    expect(types.slice(0, 4)).toEqual(['root', 'heading', 'text', 'paragraph']);
  });
});

describe('matches()', () => {
  it('normalizes underscores, spacing, and case', () => {
    const node = wikilink('Main_Page', []);
    expect(matches(node, ' main page ')).toBe(true);
  });
});

describe('event-level helpers', () => {
  it('filters events lazily by predicate', () => {
    const input = 'A [[Page|home]] link';
    const entered = Array.from(filterEvents(events(input), (event) => event.kind === 'enter'));

    expect(entered.some((event) => event.kind === 'enter' && event.node_type === 'wikilink')).toBe(true);
  });

  it('collects complete event slices for matching node types', () => {
    const groups = collectEvents(events('A [[Page|home]] link'), 'wikilink');

    expect(groups).toHaveLength(1);
    expect(groups[0][0].kind).toBe('enter');
    expect(groups[0][groups[0].length - 1].kind).toBe('exit');
  });
});

describe('diagnostic helpers', () => {
  it('resolves a tree path to a concrete node location', () => {
    const tree = parse("A '''bold''' word");
    const location = resolveTreePath(tree, [0, 1]);

    expect(location?.node.type).toBe('bold');
    expect(location?.parent?.type).toBe('paragraph');
    expect(location?.index).toBe(1);
  });

  it('locates the nearest node for a parse diagnostic', () => {
    const result = parseWithDiagnostics('{|\n| Cell');
    const location = locateDiagnostic(result.tree, result.diagnostics[0]);

    expect(location?.node.type).toBe('text');
    expect(location?.parent?.type).toBe('root');
    expect(location?.index).toBe(0);
  });

  it('resolves a diagnostic anchor directly', () => {
    const result = parseWithDiagnostics('{|\n| Cell');
    const location = resolveDiagnosticAnchor(
      result.tree,
      result.diagnostics[0].anchor,
    );

    expect(location?.node.type).toBe('text');
    expect(location?.parent?.type).toBe('root');
    expect(location?.index).toBe(0);
  });

  it('returns undefined for a stale or invalid tree path', () => {
    const tree = parse('== Title ==\n\nText');
    expect(resolveTreePath(tree, [99])).toBeUndefined();
  });

  it('returns undefined for a stale diagnostic anchor path', () => {
    const tree = parse('== Title ==\n\nText');

    // Diagnostics are resolved against one concrete final tree. If a caller
    // keeps an anchor but later resolves it against a different or reshaped
    // tree, the helper should fail closed instead of guessing.
    expect(resolveDiagnosticAnchor(tree, {
      kind: 'tree-path',
      path: [99],
      node_type: 'heading',
    })).toBeUndefined();
  });
});