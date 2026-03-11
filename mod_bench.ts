/**
 * Foundational micro-benchmarks that do not belong to a specific parser layer.
 *
 * Layer-specific suites live in dedicated files for faster iteration.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import {
  enterEvent,
  errorEvent,
  exitEvent,
  textEvent,
  tokenEvent,
} from './events.ts';
import { isToken, TokenType } from './token.ts';

type BenchPoint = {
  line: number;
  column: number;
  offset: number;
};

type BenchPosition = {
  start: BenchPoint;
  end: BenchPoint;
};

function createBenchPosition(offset: number): BenchPosition {
  return {
    start: {
      line: 1,
      column: offset + 1,
      offset,
    },
    end: {
      line: 1,
      column: offset + 5,
      offset: offset + 4,
    },
  };
}

const VALID_TOKEN = {
  type: TokenType.TEXT,
  start: 0,
  end: 4,
};

const INVALID_TOKEN = {
  type: 'text',
  start: 0,
  end: 4,
};

summary(() => {
  bench('isToken(): valid token', () => {
    do_not_optimize(isToken(VALID_TOKEN));
  });

  bench('isToken(): invalid token', () => {
    do_not_optimize(isToken(INVALID_TOKEN));
  });
});

summary(() => {
  bench('event constructor: enter', () => {
    const position = createBenchPosition(12);
    do_not_optimize(enterEvent('paragraph', {}, position));
  });

  bench('event constructor: exit', () => {
    const position = createBenchPosition(12);
    do_not_optimize(exitEvent('paragraph', position));
  });

  bench('event constructor: text', () => {
    const position = createBenchPosition(12);
    do_not_optimize(textEvent(position.start.offset, position.end.offset, position));
  });

  bench('event constructor: token', () => {
    const position = createBenchPosition(12);
    do_not_optimize(
      tokenEvent(TokenType.TEXT, position.start.offset, position.end.offset, position),
    );
  });

  bench('event constructor: error', () => {
    const position = createBenchPosition(12);
    do_not_optimize(errorEvent('invalid-benchmark', position));
  });
});

summary(() => {
  bench('position object: fixed offset lookup', () => {
    const position = createBenchPosition(4096);
    do_not_optimize(position.start.offset + position.end.offset);
  });
});

await run();
