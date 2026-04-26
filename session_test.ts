/**
 * Tests for session.ts.
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
import {
  BARE_URI_ACCEPTANCE_FIXTURES,
  BARE_URI_REJECTION_FIXTURES,
  EXPLICIT_URI_ACCEPTANCE_FIXTURES,
} from './_test_utils/uri_fixtures.ts';
import { UNICODE_TEXT_FIXTURES } from './_test_utils/unicode_fixtures.ts';
import { DiagnosticCode } from './events.ts';
import { createSession } from './session.ts';
import {
  analyze,
  events,
  materialize,
  outlineEvents,
  parse,
  parseStrictWithDiagnostics,
  parseWithDiagnostics,
  parseWithRecovery,
} from './parse.ts';
import { TreeMaterializationPolicy } from './tree_builder.ts';
import type { TextSource } from './text_source.ts';

const SESSION_FIXTURES = [
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
  [
    '[[[[{{{{<!--',
    '__BROKEN_',
    '<ref name="n">',
    "'''''",
    '&broken',
    '{|',
    '| [[Page|{{T|x}}]] || <span class="x">text',
  ].join('\n'),
  'Paragraph with <ref name="n"',
] as const;

type CountedSource = TextSource & {
  readonly counters: {
    char_code_at_calls: number;
    slice_calls: number;
  };
};

type TreeLikeNode = {
  readonly type: string;
  readonly children?: readonly TreeLikeNode[];
  readonly url?: string;
};

function externalLinkUrlsFromTree(root: TreeLikeNode): string[] {
  const result: string[] = [];

  function walk(node: TreeLikeNode): void {
    if (node.type === 'external-link' && typeof node.url === 'string') {
      result.push(node.url);
    }

    for (const child of node.children ?? []) {
      walk(child);
    }
  }

  walk(root);
  return result;
}

function createCountedSource(value: string): CountedSource {
  const counters = {
    char_code_at_calls: 0,
    slice_calls: 0,
  };

  return {
    get length() {
      return value.length;
    },

    charCodeAt(index: number): number {
      counters.char_code_at_calls++;
      return value.charCodeAt(index);
    },

    slice(start: number, end: number): string {
      counters.slice_calls++;
      return value.slice(start, end);
    },

    counters,
  };
}

describe('createSession()', () => {
  it('exposes the original source through session.source', () => {
    const source = createCountedSource('== Title ==\n\nText');
    const session = createSession(source);

    expect(session.source).toBe(source);
  });

  it('returns cached outline and full event streams', () => {
    const input = '== Title ==\n\nA [[Page|home]] link';
    const session = createSession(input);

    expect(Array.from(session.outline())).toEqual(Array.from(outlineEvents(input)));
    expect(Array.from(session.events())).toEqual(Array.from(events(input)));
  });

  it('reuses the cached outline parse on repeated outline() calls', () => {
    const source = createCountedSource('== Title ==\n\nA paragraph line');
    const session = createSession(source);

    const first = Array.from(session.outline());
    const first_char_calls = source.counters.char_code_at_calls;
    const second = Array.from(session.outline());

    expect(second).toEqual(first);
    expect(source.counters.char_code_at_calls).toBe(first_char_calls);
  });

  it('reuses the cached full event stream on repeated events() calls', () => {
    const source = createCountedSource('A [[Page|home]] link with {{Template|one}}');
    const session = createSession(source);

    const first = Array.from(session.events());
    const first_char_calls = source.counters.char_code_at_calls;
    const second = Array.from(session.events());

    expect(second).toEqual(first);
    expect(source.counters.char_code_at_calls).toBe(first_char_calls);
  });

  it('parse() after events() reuses cached events and only materializes tree', () => {
    const source = createCountedSource('A [[Page|home]] link and plain text');
    const session = createSession(source);

    Array.from(session.events());
    const char_calls_before_parse = source.counters.char_code_at_calls;
    const slice_calls_before_parse = source.counters.slice_calls;

    const tree = session.parse();

    expect(tree.type).toBe('root');
    expect(source.counters.char_code_at_calls).toBe(char_calls_before_parse);
    expect(source.counters.slice_calls).toBeGreaterThan(slice_calls_before_parse);
  });

  it('caches the parsed tree object', () => {
    const session = createSession("A '''bold''' word");
    const first = session.parse();
    const second = session.parse();

    expect(first).toBe(second);
    expect(first).toEqual(parse("A '''bold''' word"));
  });

  it('matches the stateless pipeline across representative mixed inputs', () => {
    for (const input of SESSION_FIXTURES) {
      const session = createSession(input);

      const expected_outline = Array.from(outlineEvents(input));
      const expected_events = Array.from(events(input));
      const expected_tree = parse(input);

      expect(Array.from(session.outline())).toEqual(expected_outline);
      expect(Array.from(session.outline())).toEqual(expected_outline);
      expect(Array.from(session.events())).toEqual(expected_events);
      expect(Array.from(session.events())).toEqual(expected_events);
      expect(session.parse()).toEqual(expected_tree);
      expect(session.parse()).toEqual(expected_tree);
    }
  });

  it('matches the stateless diagnostics API on both uncached and cached calls', () => {
    for (const input of SESSION_FIXTURES) {
      const session = createSession(input);
      const expected_diagnostics = parseWithDiagnostics(input);

      expect(session.parseWithDiagnostics()).toEqual(expected_diagnostics);
      expect(session.parseWithDiagnostics()).toEqual(expected_diagnostics);
    }
  });

  it('matches the stateless recovery API on both uncached and cached calls', () => {
    for (const input of SESSION_FIXTURES) {
      const session = createSession(input);
      const expected_recovery = parseWithRecovery(input);

      expect(session.parseWithRecovery()).toEqual(expected_recovery);
      expect(session.parseWithRecovery()).toEqual(expected_recovery);
    }
  });

  it('keeps diagnostics and recovery lanes distinct when queried on the same session', () => {
    for (const input of SESSION_FIXTURES) {
      const diagnostics_first = createSession(input);
      const recovery_first = createSession(input);

      expect(diagnostics_first.parseWithDiagnostics()).toEqual(parseWithDiagnostics(input));
      expect(diagnostics_first.parseWithRecovery()).toEqual(parseWithRecovery(input));

      expect(recovery_first.parseWithRecovery()).toEqual(parseWithRecovery(input));
      expect(recovery_first.parseWithDiagnostics()).toEqual(parseWithDiagnostics(input));
    }
  });

  it('keeps representative Unicode text classes stable across cached session layers', () => {
    for (const fixture of UNICODE_TEXT_FIXTURES) {
      const input = [
        `== ${fixture.sample} ==`,
        fixture.sample,
        `* ${fixture.sample}`,
        '',
      ].join('\n');
      const session = createSession(input);
      const diagnostic_result = session.parseWithDiagnostics();

      // This mirrors the stateless Unicode matrix, but through the cache
      // wrapper. The goal is to prove that cached outline/events/tree lanes do
      // not accidentally normalize, drop, or misclassify unusual payload text.
      expect(Array.from(session.outline())).toEqual(Array.from(outlineEvents(input)));
      expect(Array.from(session.events())).toEqual(Array.from(events(input)));
      expect(session.parse()).toEqual(parse(input));
      expect(diagnostic_result).toEqual(parseWithDiagnostics(input));
      expect(diagnostic_result.diagnostics).toEqual([]);
    }
  });

  it('keeps representative Unicode text classes stable in repeated session stress inputs', () => {
    for (const fixture of UNICODE_TEXT_FIXTURES) {
      const input = `${fixture.sample}\n`.repeat(512);
      const session = createSession(input);

      // Repeated plain-text lines are a useful session check because they keep
      // the block structure simple while forcing the caches to replay a lot of
      // line tracking and paragraph continuation work.
      expect(session.parseWithDiagnostics().diagnostics).toEqual([]);
      expect(session.parse().type).toBe('root');
      expect(Array.from(session.events()).some((event) => event.kind === 'text')).toBe(true);
    }
  });

  it('keeps cached results stable across different consumer access orders', () => {
    const input = SESSION_FIXTURES[0];
    const source = createCountedSource(input);
    const session = createSession(source);

    const first_tree = session.parse();
    const char_calls_after_parse = source.counters.char_code_at_calls;
    const outline = Array.from(session.outline());
    const full_events = Array.from(session.events());

    expect(first_tree).toEqual(parse(input));
    expect(outline).toEqual(Array.from(outlineEvents(input)));
    expect(full_events).toEqual(Array.from(events(input)));
    expect(source.counters.char_code_at_calls).toBe(char_calls_after_parse);
  });

  it('preserves the shared URI acceptance matrix through cached tree APIs', () => {
    for (const fixture of [...BARE_URI_ACCEPTANCE_FIXTURES, ...EXPLICIT_URI_ACCEPTANCE_FIXTURES]) {
      const session = createSession(fixture.input);
      expect(externalLinkUrlsFromTree(session.parse())).toContain(fixture.url);
      expect(externalLinkUrlsFromTree(session.parseWithDiagnostics().tree)).toContain(fixture.url);
    }

    for (const input of BARE_URI_REJECTION_FIXTURES) {
      const session = createSession(input);
      expect(externalLinkUrlsFromTree(session.parse())).toEqual([]);
      expect(externalLinkUrlsFromTree(session.parseWithDiagnostics().tree)).toEqual([]);
    }
  });

  it('keeps the cheap parse lane separate from diagnostics-enabled event caches', () => {
    const input = 'Paragraph with <ref name="cite-1">note';
    const source = createCountedSource(input);
    const session = createSession(source);

    session.parse();
    const char_calls_after_parse = source.counters.char_code_at_calls;

    Array.from(session.events({ diagnostics: true }));
    const char_calls_after_first_events = source.counters.char_code_at_calls;
    Array.from(session.events({ diagnostics: true }));

    expect(char_calls_after_first_events).toBeGreaterThan(char_calls_after_parse);
    expect(source.counters.char_code_at_calls).toBe(char_calls_after_first_events);
  });

  it('never throws and stays equivalent to stateless APIs on syntax-heavy fuzz input', () => {
    fc.assert(
      fc.property(
        wikiish_string(),
        spacing_heavy_wikitext_string(),
        pathological_wikitext_string(),
        (a: string, b: string, c: string) => {
          const input = `${a}\n${b}\n${c}`;
          const session = createSession(input);

          expect(Array.from(session.outline())).toEqual(Array.from(outlineEvents(input)));
          expect(Array.from(session.events())).toEqual(Array.from(events(input)));
          expect(session.parse()).toEqual(parse(input));
        },
      ),
    );
  });

  it('keeps session.parse() usable on mixed Unicode and recovery-heavy inputs', () => {
    fc.assert(
      fc.property(
        odd_character_wikitext_string(),
        pathological_wikitext_string(),
        (odd: string, hostile: string) => {
          const input = `${odd}\n${hostile}`;
          const session = createSession(input);

          expect(session.parse().type).toBe('root');
        },
      ),
    );
  });

  it('parseWithDiagnostics() matches the stateless diagnostic API', () => {
    for (const input of SESSION_FIXTURES) {
      const session = createSession(input);
      expect(session.parseWithDiagnostics()).toEqual(parseWithDiagnostics(input));
    }
  });

  it('reuses the cached diagnostics result on repeated parseWithDiagnostics() calls', () => {
    const input = '{|\n| Cell';
    const source = createCountedSource(input);
    const session = createSession(source);

    const first = session.parseWithDiagnostics();
    const first_char_calls = source.counters.char_code_at_calls;
    const second = session.parseWithDiagnostics();

    expect(second).toBe(first);
    expect(second).toEqual(parseWithDiagnostics(input));
    expect(source.counters.char_code_at_calls).toBe(first_char_calls);
  });

  it('parseWithDiagnostics() does not expose the recovery summary field', () => {
    const session = createSession(SESSION_FIXTURES[0]);

    expect(Object.hasOwn(session.parseWithDiagnostics(), 'recovered')).toBe(false);
  });

  it('parseWithRecovery() matches the stateless recovery-aware API', () => {
    for (const input of SESSION_FIXTURES) {
      const session = createSession(input);
      expect(session.parseWithRecovery()).toEqual(parseWithRecovery(input));
    }
  });

  it('reuses the cached recovery result on repeated parseWithRecovery() calls', () => {
    const input = '{|\n| Cell';
    const source = createCountedSource(input);
    const session = createSession(source);

    const first = session.parseWithRecovery();
    const first_char_calls = source.counters.char_code_at_calls;
    const second = session.parseWithRecovery();

    expect(second).toBe(first);
    expect(second).toEqual(parseWithRecovery(input));
    expect(source.counters.char_code_at_calls).toBe(first_char_calls);
  });

  it('parseWithDiagnostics() preserves real parser diagnostics from recovery input', () => {
    const input = '{|\n| Cell';
    const session = createSession(input);
    const result = session.parseWithDiagnostics();

    expect(result.tree.type).toBe('root');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.UNCLOSED_TABLE);
    expect(result.diagnostics[0].source).toBe('block');
    expect(result.diagnostics[0].anchor).toEqual({
      kind: 'tree-path',
      path: [0],
      node_type: 'table',
    });
    expect(result.diagnostics[0].recoverable).toBe(true);
    expect(result.diagnostics[0].severity).toBe('warning');
  });

  it('reuses the same default tree shape as parse()', () => {
    const session = createSession('{|\n| Cell');
    const tree = session.parse();
    const result = session.parseWithDiagnostics();

    expect(result.tree).toEqual(tree);
  });

  it('parseWithRecovery() keeps the same tree as parseWithDiagnostics() and adds only the summary', () => {
    const session = createSession('{|\n| Cell');
    const diagnostics_result = session.parseWithDiagnostics();
    const recovery_result = session.parseWithRecovery();

    expect(recovery_result.diagnostics).toHaveLength(diagnostics_result.diagnostics.length);
    expect(recovery_result.diagnostics[0]?.code).toBe(diagnostics_result.diagnostics[0]?.code);
    expect(recovery_result.diagnostics[0]?.message).toBe(diagnostics_result.diagnostics[0]?.message);
    expect(recovery_result.diagnostics[0]?.source).toBe(diagnostics_result.diagnostics[0]?.source);
    expect(recovery_result.diagnostics[0]?.severity).toBe(diagnostics_result.diagnostics[0]?.severity);
    expect(recovery_result.diagnostics[0]?.recoverable).toBe(
      diagnostics_result.diagnostics[0]?.recoverable,
    );
    expect(recovery_result.diagnostics[0]?.position).toEqual(
      diagnostics_result.diagnostics[0]?.position,
    );
    expect(recovery_result.diagnostics[0]?.anchor.node_type).toBe('table');
    expect(diagnostics_result.diagnostics[0]?.anchor.node_type).toBe('table');
    expect(recovery_result.recovered).toBe(true);
    expect(recovery_result.tree.children[0]?.type).toBe('table');
    expect(diagnostics_result.tree.children[0]?.type).toBe('table');
  });

  it('parseStrictWithDiagnostics() matches the stateless conservative diagnostics API', () => {
    for (const input of SESSION_FIXTURES) {
      const session = createSession(input);
      expect(session.parseStrictWithDiagnostics()).toEqual(parseStrictWithDiagnostics(input));
    }
  });

  it('parseStrictWithDiagnostics() keeps conservative materialization distinct from the default diagnostics lane', () => {
    const session = createSession('{|\n| Cell');
    const strict_result = session.parseStrictWithDiagnostics();
    const diagnostics_result = session.parseWithDiagnostics();

    expect(strict_result.diagnostics).toHaveLength(diagnostics_result.diagnostics.length);
    expect(strict_result.diagnostics[0]?.code).toBe(diagnostics_result.diagnostics[0]?.code);
    expect(strict_result.diagnostics[0]?.message).toBe(diagnostics_result.diagnostics[0]?.message);
    expect(strict_result.diagnostics[0]?.source).toBe(diagnostics_result.diagnostics[0]?.source);
    expect(strict_result.tree.children[0]?.type).toBe('text');
    expect(diagnostics_result.tree.children[0]?.type).toBe('table');
  });
});
describe('Session.analyze() and Session.materialize()', () => {
  it('analyze() matches the stateless analyze() API', () => {
    for (const input of SESSION_FIXTURES) {
      const session = createSession(input);
      const session_findings = session.analyze();
      const stateless_findings = analyze(input);

      expect(session_findings.diagnostics).toEqual(stateless_findings.diagnostics);
      expect(session_findings.recovery).toEqual(stateless_findings.recovery);
      expect(session_findings.events.length).toBe(stateless_findings.events.length);
    }
  });

  it('analyze() returns the same cached findings on repeated calls', () => {
    const session = createSession('Paragraph with <ref name="cite-1">note');
    const first = session.analyze();
    const second = session.analyze();

    expect(second).toBe(first);
  });

  it('analyze() strips recovery when options.recovery is false', () => {
    const session = createSession('{|\n| Cell');
    const findings = session.analyze({ recovery: false });

    expect(findings.diagnostics.length).toBeGreaterThan(0);
    expect(findings.recovery).toBeUndefined();
  });

  it('materialize() defaults to the default-html-like tree', () => {
    const input = 'Paragraph with <ref name="cite-1">note';
    const session = createSession(input);
    const output = session.materialize();

    expect(output).toEqual(materialize(analyze(input)));
  });

  it('materialize() honors the source-strict policy', () => {
    const input = 'Paragraph with <ref name="cite-1">note';
    const session = createSession(input);
    const output = session.materialize({
      policy: TreeMaterializationPolicy.SOURCE_STRICT,
    });

    expect(output).toEqual(
      materialize(analyze(input), { policy: TreeMaterializationPolicy.SOURCE_STRICT }),
    );
  });

  it('materialize() reuses cached trees across repeated calls', () => {
    const session = createSession('Paragraph with <ref name="cite-1">note');
    const first = session.materialize();
    const second = session.materialize();

    expect(second.tree).toBe(first.tree);
  });
});
