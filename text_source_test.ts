/**
 * Dedicated tests for text_source.ts.
 *
 * Covers the TextSource interface (string conformance, custom
 * implementations), the slice() helper, and edge cases for Unicode,
 * astral characters, empty strings, and boundary offsets.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';
import * as fc from 'npm:fast-check';

import type { TextSource } from './text_source.ts';
import { slice } from './text_source.ts';

// ---------------------------------------------------------------------------
// TextSource — string conformance
// ---------------------------------------------------------------------------

describe('TextSource — string conformance', () => {
  it('plain string satisfies TextSource', () => {
    const src: TextSource = 'hello';
    expect(src.length).toBe(5);
    expect(src.charCodeAt(0)).toBe(0x68); // 'h'
    expect(src.slice(0, 5)).toBe('hello');
  });

  it('empty string satisfies TextSource', () => {
    const src: TextSource = '';
    expect(src.length).toBe(0);
    expect(src.slice(0, 0)).toBe('');
  });

  it('single character string', () => {
    const src: TextSource = 'x';
    expect(src.length).toBe(1);
    expect(src.charCodeAt(0)).toBe(0x78);
    expect(src.slice(0, 1)).toBe('x');
  });

  it('reports NaN for out-of-range charCodeAt index', () => {
    const src: TextSource = 'abc';
    expect(src.charCodeAt(-1)).toBeNaN();
    expect(src.charCodeAt(3)).toBeNaN();
    expect(src.charCodeAt(100)).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// TextSource — Unicode and astral characters
// ---------------------------------------------------------------------------

describe('TextSource — Unicode', () => {
  it('handles CJK characters', () => {
    const src: TextSource = '日本語';
    expect(src.length).toBe(3);
    expect(src.charCodeAt(0)).toBe(0x65E5); // 日
    expect(src.slice(0, 1)).toBe('日');
    expect(src.slice(1, 3)).toBe('本語');
  });

  it('handles RTL text (Arabic)', () => {
    const src: TextSource = 'مرحبا';
    expect(src.length).toBe(5);
    expect(src.slice(0, 5)).toBe('مرحبا');
  });

  it('handles astral Unicode (emoji) as surrogate pairs', () => {
    // 🌍 is U+1F30D, encoded as two UTF-16 code units.
    const src: TextSource = '🌍';
    expect(src.length).toBe(2);
    // First surrogate
    expect(src.charCodeAt(0)).toBe(0xD83C);
    // Second surrogate
    expect(src.charCodeAt(1)).toBe(0xDF0D);
    expect(src.slice(0, 2)).toBe('🌍');
  });

  it('handles mixed ASCII and astral characters', () => {
    const src: TextSource = 'Hi 🌍!';
    // 'H' 'i' ' ' 0xD83C 0xDF0D '!'
    expect(src.length).toBe(6);
    expect(src.slice(0, 2)).toBe('Hi');
    expect(src.slice(3, 5)).toBe('🌍');
    expect(src.slice(5, 6)).toBe('!');
  });

  it('handles null byte', () => {
    const src: TextSource = 'a\0b';
    expect(src.length).toBe(3);
    expect(src.charCodeAt(1)).toBe(0);
    expect(src.slice(0, 3)).toBe('a\0b');
  });
});

// ---------------------------------------------------------------------------
// TextSource — line endings
// ---------------------------------------------------------------------------

describe('TextSource — line endings', () => {
  it('handles LF', () => {
    const src: TextSource = 'a\nb';
    expect(src.length).toBe(3);
    expect(src.charCodeAt(1)).toBe(0x0A);
    expect(src.slice(0, 1)).toBe('a');
    expect(src.slice(2, 3)).toBe('b');
  });

  it('handles CRLF', () => {
    const src: TextSource = 'a\r\nb';
    expect(src.length).toBe(4);
    expect(src.charCodeAt(1)).toBe(0x0D);
    expect(src.charCodeAt(2)).toBe(0x0A);
  });

  it('handles bare CR', () => {
    const src: TextSource = 'a\rb';
    expect(src.length).toBe(3);
    expect(src.charCodeAt(1)).toBe(0x0D);
  });
});

// ---------------------------------------------------------------------------
// slice() helper
// ---------------------------------------------------------------------------

describe('slice()', () => {
  it('resolves a mid-string range', () => {
    expect(slice('== Heading ==', 3, 10)).toBe('Heading');
  });

  it('resolves full string', () => {
    expect(slice('hello', 0, 5)).toBe('hello');
  });

  it('resolves zero-length range', () => {
    expect(slice('hello', 2, 2)).toBe('');
  });

  it('resolves at start', () => {
    expect(slice('abcdef', 0, 3)).toBe('abc');
  });

  it('resolves at end', () => {
    expect(slice('abcdef', 3, 6)).toBe('def');
  });

  it('resolves single character', () => {
    expect(slice('abcdef', 2, 3)).toBe('c');
  });

  it('resolves from empty string', () => {
    expect(slice('', 0, 0)).toBe('');
  });

  it('works with CJK ranges', () => {
    expect(slice('日本語テスト', 2, 5)).toBe('語テス');
  });

  it('works with astral character boundaries', () => {
    // '🌍' takes offsets 0 and 1 (surrogate pair).
    expect(slice('🌍abc', 0, 2)).toBe('🌍');
    expect(slice('🌍abc', 2, 5)).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// TextSource — custom implementation
// ---------------------------------------------------------------------------

describe('TextSource — custom implementation', () => {
  /** A minimal TextSource backed by an array of code points. */
  class ArraySource implements TextSource {
    readonly length: number;
    private readonly _str: string;

    constructor(str: string) {
      this._str = str;
      this.length = str.length;
    }

    // These methods intentionally delegate straight to the backing string so
    // the tests stay focused on interface conformance, not on inventing a new
    // text model with subtly different semantics.
    charCodeAt(index: number): number {
      return this._str.charCodeAt(index);
    }

    slice(start: number, end: number): string {
      return this._str.slice(start, end);
    }
  }

  it('custom TextSource works with slice() helper', () => {
    const src = new ArraySource('abcdef');
    expect(slice(src, 1, 4)).toBe('bcd');
  });

  it('custom TextSource has correct length', () => {
    const src = new ArraySource('test');
    expect(src.length).toBe(4);
  });

  it('custom TextSource charCodeAt matches string behavior', () => {
    const str = 'hello';
    const src = new ArraySource(str);
    for (let i = 0; i < str.length; i++) {
      expect(src.charCodeAt(i)).toBe(str.charCodeAt(i));
    }
  });
});

// ---------------------------------------------------------------------------
// TextSource with iterSlices (optional method)
// ---------------------------------------------------------------------------

describe('TextSource — iterSlices', () => {
  /** A TextSource that exposes iterSlices for chunked access. */
  class ChunkedSource implements TextSource {
    readonly length: number;
    private readonly _chunks: string[];
    private readonly _str: string;

    constructor(chunks: string[]) {
      this._chunks = chunks;
      this._str = chunks.join('');
      this.length = this._str.length;
    }

    charCodeAt(index: number): number {
      return this._str.charCodeAt(index);
    }

    slice(start: number, end: number): string {
      return this._str.slice(start, end);
    }

    *iterSlices(start: number, end: number): Iterable<string> {
      // Simple implementation: just yield the slice.
      yield this._str.slice(start, end);
    }
  }

  it('iterSlices produces the same content as slice', () => {
    const src = new ChunkedSource(['Hello', ' ', 'World']);
    const sliced = src.slice(0, 11);
    const iterated = [...src.iterSlices!(0, 11)].join('');
    expect(iterated).toBe(sliced);
  });

  it('iterSlices works for sub-ranges', () => {
    const src = new ChunkedSource(['abc', 'def']);
    const iterated = [...src.iterSlices!(2, 5)].join('');
    expect(iterated).toBe('cde');
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('TextSource — property-based', () => {
  it('slice(str, 0, str.length) === str for any string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(slice(s, 0, s.length)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });

  it('slice(str, i, i) is always empty for valid i', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const i = Math.min(Math.floor(s.length / 2), s.length);
        expect(slice(s, i, i)).toBe('');
      }),
      { numRuns: 300 },
    );
  });

  it('slice(str, a, b) matches String.prototype.slice(a, b)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (s) => {
          if (s.length < 2) return;
          const a = Math.floor(s.length / 3);
          const b = Math.floor((2 * s.length) / 3);
          expect(slice(s, a, b)).toBe(s.slice(a, b));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('string length equals TextSource.length', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const src: TextSource = s;
        expect(src.length).toBe(s.length);
      }),
      { numRuns: 300 },
    );
  });

  it('charCodeAt matches for all valid indices', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 50 }), (s) => {
        const src: TextSource = s;
        for (let i = 0; i < s.length; i++) {
          expect(src.charCodeAt(i)).toBe(s.charCodeAt(i));
        }
      }),
      { numRuns: 200 },
    );
  });
});
