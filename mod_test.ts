/**
 * Smoke tests for the mod.ts barrel re-export.
 *
 * These tests verify that all public APIs are accessible through the
 * single `mod.ts` entrypoint. They are intentionally shallow: each test
 * imports from `./mod.ts` (the same path consumers use) and confirms that
 * the imported value exists and has the expected shape.
 *
 * Detailed behavioral tests for individual modules live in `ast_test.ts`
 * and future per-module test files.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';

import {
  TokenType,
  argument,
  enterEvent,
  errorEvent,
  exitEvent,
  heading,
  inlineEvents,
  isToken,
  root,
  slice,
  text,
  textEvent,
  tokenEvent,
} from './mod.ts';
import type {
  TextSource,
  Token,
  WikistNode,
  WikitextEvent,
} from './mod.ts';

/** A minimal Position for tests that don't care about source location. */
const pos = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 2, offset: 1 },
} as const;

describe('mod.ts exports', () => {
  it('re-exports TextSource-compatible helpers', () => {
    const src: TextSource = 'abc';
    expect(src.length).toBe(3);
    expect(slice(src, 1, 3)).toBe('bc');
  });

  it('re-exports token API', () => {
    const tok: Token = { type: TokenType.TEXT, start: 0, end: 1 };
    expect(isToken(tok)).toBe(true);
    expect(TokenType.EOF).toBe('EOF');
  });

  it('re-exports event constructors', () => {
    const events: WikitextEvent[] = [
      enterEvent('paragraph', {}, pos),
      textEvent(0, 1, pos),
      tokenEvent(TokenType.TEXT, 0, 1, pos),
      errorEvent('recoverable parse point', pos),
      exitEvent('paragraph', pos),
    ];
    expect(events.map((evt) => evt.kind)).toEqual([
      'enter',
      'text',
      'token',
      'error',
      'exit',
    ]);

    const diagnostic = errorEvent('recoverable parse point', pos, {
      severity: 'warning',
      code: 'INLINE_RECOVERY',
      recoverable: true,
      source: 'inline',
      details: { context: 'quote-run' },
    });
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.code).toBe('INLINE_RECOVERY');
    expect(diagnostic.recoverable).toBe(true);
    expect(diagnostic.source).toBe('inline');
    expect(diagnostic.details).toEqual({ context: 'quote-run' });
  });

  it('re-exports AST builders', () => {
    const tree = root([heading(2, [text('Title')]), argument('param', 'fallback')]);
    const first: WikistNode = tree.children[0];
    expect(tree.type).toBe('root');
    expect(first.type).toBe('heading');
  });

  it('re-exports inline parser API', () => {
    const events = Array.from(inlineEvents('plain text', [textEvent(0, 10, {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 11, offset: 10 },
    })]));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text');
  });
});
