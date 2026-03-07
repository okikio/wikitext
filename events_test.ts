/**
 * Dedicated tests for events.ts.
 *
 * Covers all five event constructors, all five type guards, the
 * ErrorEventOptions spread behavior, position field integrity, and
 * property-based invariants for the discriminated union.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';
import * as fc from 'npm:fast-check';

import {
  enterEvent,
  errorEvent,
  exitEvent,
  isEnterEvent,
  isErrorEvent,
  isExitEvent,
  isTextEvent,
  isTokenEvent,
  textEvent,
  tokenEvent,
} from './events.ts';
import type {
  Point,
  Position,
  WikitextEvent,
} from './events.ts';
import { TokenType } from './token.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A reusable position for tests that don't care about exact location. */
const pos: Position = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 10, offset: 9 },
};

/** A different position to test field identity. */
const pos2: Position = {
  start: { line: 3, column: 5, offset: 20 },
  end: { line: 3, column: 15, offset: 30 },
};

// ---------------------------------------------------------------------------
// enterEvent
// ---------------------------------------------------------------------------

describe('enterEvent', () => {
  it('sets kind to "enter"', () => {
    const evt = enterEvent('heading', { level: 2 }, pos);
    expect(evt.kind).toBe('enter');
  });

  it('preserves node_type', () => {
    const evt = enterEvent('paragraph', {}, pos);
    expect(evt.node_type).toBe('paragraph');
  });

  it('preserves props with multiple fields', () => {
    const evt = enterEvent('list', { ordered: true, depth: 3 }, pos);
    expect(evt.props).toEqual({ ordered: true, depth: 3 });
  });

  it('preserves empty props', () => {
    const evt = enterEvent('root', {}, pos);
    expect(evt.props).toEqual({});
  });

  it('preserves position reference', () => {
    const evt = enterEvent('heading', {}, pos2);
    expect(evt.position).toBe(pos2);
  });

  it('creates distinct objects per call', () => {
    const a = enterEvent('heading', { level: 1 }, pos);
    const b = enterEvent('heading', { level: 1 }, pos);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// exitEvent
// ---------------------------------------------------------------------------

describe('exitEvent', () => {
  it('sets kind to "exit"', () => {
    const evt = exitEvent('heading', pos);
    expect(evt.kind).toBe('exit');
  });

  it('preserves node_type', () => {
    const evt = exitEvent('table', pos);
    expect(evt.node_type).toBe('table');
  });

  it('preserves position reference', () => {
    const evt = exitEvent('paragraph', pos2);
    expect(evt.position).toBe(pos2);
  });
});

// ---------------------------------------------------------------------------
// textEvent
// ---------------------------------------------------------------------------

describe('textEvent', () => {
  it('sets kind to "text"', () => {
    const evt = textEvent(0, 5, pos);
    expect(evt.kind).toBe('text');
  });

  it('preserves offset fields', () => {
    const evt = textEvent(10, 25, pos);
    expect(evt.start_offset).toBe(10);
    expect(evt.end_offset).toBe(25);
  });

  it('handles zero-length range', () => {
    const evt = textEvent(5, 5, pos);
    expect(evt.start_offset).toBe(5);
    expect(evt.end_offset).toBe(5);
  });

  it('handles offset 0', () => {
    const evt = textEvent(0, 0, pos);
    expect(evt.start_offset).toBe(0);
    expect(evt.end_offset).toBe(0);
  });

  it('preserves position reference', () => {
    const evt = textEvent(0, 1, pos2);
    expect(evt.position).toBe(pos2);
  });
});

// ---------------------------------------------------------------------------
// tokenEvent
// ---------------------------------------------------------------------------

describe('tokenEvent', () => {
  it('sets kind to "token"', () => {
    const evt = tokenEvent(TokenType.TEXT, 0, 5, pos);
    expect(evt.kind).toBe('token');
  });

  it('preserves token_type', () => {
    const evt = tokenEvent(TokenType.HEADING_MARKER, 0, 2, pos);
    expect(evt.token_type).toBe('HEADING_MARKER');
  });

  it('preserves offset fields', () => {
    const evt = tokenEvent(TokenType.NEWLINE, 10, 11, pos);
    expect(evt.start_offset).toBe(10);
    expect(evt.end_offset).toBe(11);
  });

  it('preserves position reference', () => {
    const evt = tokenEvent(TokenType.EOF, 0, 0, pos2);
    expect(evt.position).toBe(pos2);
  });
});

// ---------------------------------------------------------------------------
// errorEvent
// ---------------------------------------------------------------------------

describe('errorEvent', () => {
  it('sets kind to "error"', () => {
    const evt = errorEvent('test error', pos);
    expect(evt.kind).toBe('error');
  });

  it('preserves message', () => {
    const evt = errorEvent('Unclosed template', pos);
    expect(evt.message).toBe('Unclosed template');
  });

  it('preserves position reference', () => {
    const evt = errorEvent('msg', pos2);
    expect(evt.position).toBe(pos2);
  });

  it('includes no extra keys when no options passed', () => {
    const evt = errorEvent('msg', pos);
    expect(evt.severity).toBeUndefined();
    expect(evt.code).toBeUndefined();
    expect(evt.recoverable).toBeUndefined();
    expect(evt.source).toBeUndefined();
    expect(evt.details).toBeUndefined();
  });

  it('merges severity option', () => {
    const evt = errorEvent('msg', pos, { severity: 'warning' });
    expect(evt.severity).toBe('warning');
  });

  it('merges code option', () => {
    const evt = errorEvent('msg', pos, { code: 'UNCLOSED_TABLE' });
    expect(evt.code).toBe('UNCLOSED_TABLE');
  });

  it('merges recoverable option', () => {
    const evt = errorEvent('msg', pos, { recoverable: true });
    expect(evt.recoverable).toBe(true);
  });

  it('merges source option', () => {
    const evt = errorEvent('msg', pos, { source: 'block' });
    expect(evt.source).toBe('block');
  });

  it('merges details option', () => {
    const evt = errorEvent('msg', pos, { details: { context: 'heading' } });
    expect(evt.details).toEqual({ context: 'heading' });
  });

  it('merges all options together', () => {
    const evt = errorEvent('msg', pos, {
      severity: 'error',
      code: 'MALFORMED_TABLE',
      recoverable: false,
      source: 'inline',
      details: { row: 3 },
    });
    expect(evt.severity).toBe('error');
    expect(evt.code).toBe('MALFORMED_TABLE');
    expect(evt.recoverable).toBe(false);
    expect(evt.source).toBe('inline');
    expect(evt.details).toEqual({ row: 3 });
  });
});

// ---------------------------------------------------------------------------
// Type guards — basic
// ---------------------------------------------------------------------------

describe('type guards', () => {
  const enter: WikitextEvent = enterEvent('heading', { level: 2 }, pos);
  const exit: WikitextEvent = exitEvent('heading', pos);
  const txt: WikitextEvent = textEvent(0, 5, pos);
  const tok: WikitextEvent = tokenEvent(TokenType.TEXT, 0, 5, pos);
  const err: WikitextEvent = errorEvent('test', pos);
  const all: WikitextEvent[] = [enter, exit, txt, tok, err];

  it('isEnterEvent accepts only enter events', () => {
    expect(isEnterEvent(enter)).toBe(true);
    expect(isEnterEvent(exit)).toBe(false);
    expect(isEnterEvent(txt)).toBe(false);
    expect(isEnterEvent(tok)).toBe(false);
    expect(isEnterEvent(err)).toBe(false);
  });

  it('isExitEvent accepts only exit events', () => {
    expect(isExitEvent(exit)).toBe(true);
    expect(isExitEvent(enter)).toBe(false);
    expect(isExitEvent(txt)).toBe(false);
    expect(isExitEvent(tok)).toBe(false);
    expect(isExitEvent(err)).toBe(false);
  });

  it('isTextEvent accepts only text events', () => {
    expect(isTextEvent(txt)).toBe(true);
    expect(isTextEvent(enter)).toBe(false);
    expect(isTextEvent(exit)).toBe(false);
    expect(isTextEvent(tok)).toBe(false);
    expect(isTextEvent(err)).toBe(false);
  });

  it('isTokenEvent accepts only token events', () => {
    expect(isTokenEvent(tok)).toBe(true);
    expect(isTokenEvent(enter)).toBe(false);
    expect(isTokenEvent(exit)).toBe(false);
    expect(isTokenEvent(txt)).toBe(false);
    expect(isTokenEvent(err)).toBe(false);
  });

  it('isErrorEvent accepts only error events', () => {
    expect(isErrorEvent(err)).toBe(true);
    expect(isErrorEvent(enter)).toBe(false);
    expect(isErrorEvent(exit)).toBe(false);
    expect(isErrorEvent(txt)).toBe(false);
    expect(isErrorEvent(tok)).toBe(false);
  });

  it('guards partition all events (every event matches exactly one guard)', () => {
    const guards = [isEnterEvent, isExitEvent, isTextEvent, isTokenEvent, isErrorEvent];
    for (const evt of all) {
      const matches = guards.filter((g) => g(evt));
      expect(matches.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Type guards — narrowing
// ---------------------------------------------------------------------------

describe('type guard narrowing', () => {
  it('narrows EnterEvent fields', () => {
    const evt: WikitextEvent = enterEvent('heading', { level: 3 }, pos);
    if (isEnterEvent(evt)) {
      // TypeScript narrows to EnterEvent here.
      const _nodeType: string = evt.node_type;
      const _props: Readonly<Record<string, unknown>> = evt.props;
      expect(_nodeType).toBe('heading');
      expect(_props).toEqual({ level: 3 });
    } else {
      throw new Error('Expected EnterEvent');
    }
  });

  it('narrows ExitEvent fields', () => {
    const evt: WikitextEvent = exitEvent('list', pos);
    if (isExitEvent(evt)) {
      const _nodeType: string = evt.node_type;
      expect(_nodeType).toBe('list');
    } else {
      throw new Error('Expected ExitEvent');
    }
  });

  it('narrows TextEvent offsets', () => {
    const evt: WikitextEvent = textEvent(3, 8, pos);
    if (isTextEvent(evt)) {
      const _start: number = evt.start_offset;
      const _end: number = evt.end_offset;
      expect(_start).toBe(3);
      expect(_end).toBe(8);
    } else {
      throw new Error('Expected TextEvent');
    }
  });

  it('narrows TokenEvent token_type', () => {
    const evt: WikitextEvent = tokenEvent(TokenType.TABLE_OPEN, 5, 7, pos);
    if (isTokenEvent(evt)) {
      const _tokenType: string = evt.token_type;
      expect(_tokenType).toBe('TABLE_OPEN');
    } else {
      throw new Error('Expected TokenEvent');
    }
  });

  it('narrows ErrorEvent message and optional fields', () => {
    const evt: WikitextEvent = errorEvent('bad input', pos, {
      severity: 'warning',
      code: 'TEST_CODE',
    });
    if (isErrorEvent(evt)) {
      const _msg: string = evt.message;
      expect(_msg).toBe('bad input');
      expect(evt.severity).toBe('warning');
      expect(evt.code).toBe('TEST_CODE');
    } else {
      throw new Error('Expected ErrorEvent');
    }
  });
});

// ---------------------------------------------------------------------------
// Position field integrity
// ---------------------------------------------------------------------------

describe('position field integrity', () => {
  it('Point fields are line, column, offset', () => {
    const pt: Point = { line: 5, column: 12, offset: 100 };
    expect(pt.line).toBe(5);
    expect(pt.column).toBe(12);
    expect(pt.offset).toBe(100);
  });

  it('Position has start and end points', () => {
    const p: Position = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 2, column: 5, offset: 15 },
    };
    expect(p.start.line).toBe(1);
    expect(p.end.line).toBe(2);
    expect(p.end.offset).toBe(15);
  });

  it('all event kinds carry a position', () => {
    const events: WikitextEvent[] = [
      enterEvent('root', {}, pos),
      exitEvent('root', pos),
      textEvent(0, 1, pos),
      tokenEvent(TokenType.TEXT, 0, 1, pos),
      errorEvent('msg', pos),
    ];
    for (const evt of events) {
      expect(evt.position).toBeDefined();
      expect(evt.position.start).toBeDefined();
      expect(evt.position.end).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('events — property-based', () => {
  /** Arbitrary Position generator. */
  const arbPoint = fc.record({
    line: fc.integer({ min: 1, max: 100_000 }),
    column: fc.integer({ min: 1, max: 10_000 }),
    offset: fc.nat({ max: 1_000_000 }),
  });
  const arbPos = fc.record({ start: arbPoint, end: arbPoint });

  it('enterEvent always produces kind "enter"', () => {
    fc.assert(
      fc.property(fc.string(), arbPos, (nodeType, p) => {
        const evt = enterEvent(nodeType, {}, p);
        expect(evt.kind).toBe('enter');
        expect(evt.node_type).toBe(nodeType);
      }),
      { numRuns: 200 },
    );
  });

  it('exitEvent always produces kind "exit"', () => {
    fc.assert(
      fc.property(fc.string(), arbPos, (nodeType, p) => {
        const evt = exitEvent(nodeType, p);
        expect(evt.kind).toBe('exit');
        expect(evt.node_type).toBe(nodeType);
      }),
      { numRuns: 200 },
    );
  });

  it('textEvent preserves arbitrary offsets', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), arbPos, (s, e, p) => {
        const evt = textEvent(s, e, p);
        expect(evt.start_offset).toBe(s);
        expect(evt.end_offset).toBe(e);
      }),
      { numRuns: 200 },
    );
  });

  it('errorEvent message round-trips', () => {
    fc.assert(
      fc.property(fc.string(), arbPos, (msg, p) => {
        const evt = errorEvent(msg, p);
        expect(evt.message).toBe(msg);
        expect(evt.kind).toBe('error');
      }),
      { numRuns: 200 },
    );
  });

  it('exactly one type guard matches any constructed event', () => {
    const guards = [isEnterEvent, isExitEvent, isTextEvent, isTokenEvent, isErrorEvent];

    fc.assert(
      fc.property(
        fc.oneof(
          arbPos.map((p) => enterEvent('test', {}, p) as WikitextEvent),
          arbPos.map((p) => exitEvent('test', p) as WikitextEvent),
          arbPos.map((p) => textEvent(0, 1, p) as WikitextEvent),
          arbPos.map((p) => tokenEvent(TokenType.TEXT, 0, 1, p) as WikitextEvent),
          arbPos.map((p) => errorEvent('msg', p) as WikitextEvent),
        ),
        (evt) => {
          const matches = guards.filter((g) => g(evt));
          expect(matches.length).toBe(1);
        },
      ),
      { numRuns: 500 },
    );
  });
});
