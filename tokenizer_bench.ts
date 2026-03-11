/**
 * Focused tokenizer benchmarks for faster iteration on scan and token emission.
 *
 * @module bench
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import

import { bench, do_not_optimize, run, summary } from 'npm:mitata';

import {
  describeTokenizeFixture,
  drainTokenize,
  drainTokenizerScanOnly,
  PLAIN_TEXT_INPUTS,
  PLAIN_TOKEN_DENSITY_STRESS_INPUTS,
  SAME_SIZE_MIXED_TEXT,
  SAME_SIZE_PATHOLOGICAL_TEXT,
  SAME_SIZE_PLAIN_TEXT,
  SAME_SIZE_PLAIN_TOKEN_DENSITY_STRESS_TEXT,
  UNICODE_BENCH_FIXTURES,
} from './_test_utils/perf_fixtures.ts';

const SAME_SIZE_PLAIN_LABEL = describeTokenizeFixture(
  'tokenize: same-size plain (~8 KB)',
  SAME_SIZE_PLAIN_TEXT,
);
const SAME_SIZE_PLAIN_TOKEN_DENSITY_STRESS_LABEL = describeTokenizeFixture(
  'tokenize: same-size plain token-density stress (~8 KB)',
  SAME_SIZE_PLAIN_TOKEN_DENSITY_STRESS_TEXT,
);
const SAME_SIZE_MIXED_LABEL = describeTokenizeFixture(
  'tokenize: same-size mixed (~8 KB)',
  SAME_SIZE_MIXED_TEXT,
);
const SAME_SIZE_PATHOLOGICAL_LABEL = describeTokenizeFixture(
  'tokenize: same-size pathological (~8 KB)',
  SAME_SIZE_PATHOLOGICAL_TEXT,
);

summary(() => {
  for (const [index, input] of PLAIN_TEXT_INPUTS.entries()) {
    bench(`scan-only: realistic plain text ${index + 1} (9 KB)`, () => {
      do_not_optimize(drainTokenizerScanOnly(input));
    });
  }

  for (const [index, input] of PLAIN_TOKEN_DENSITY_STRESS_INPUTS.entries()) {
    bench(`scan-only: token-density stress plain text ${index + 1} (9 KB)`, () => {
      do_not_optimize(drainTokenizerScanOnly(input));
    });
  }
});

summary(() => {
  bench('scan-only: same-size plain realistic (~8 KB)', () => {
    do_not_optimize(drainTokenizerScanOnly(SAME_SIZE_PLAIN_TEXT));
  });

  bench('scan-only: same-size mixed realistic (~8 KB)', () => {
    do_not_optimize(drainTokenizerScanOnly(SAME_SIZE_MIXED_TEXT));
  });

  bench('scan-only: same-size pathological realistic (~8 KB)', () => {
    do_not_optimize(drainTokenizerScanOnly(SAME_SIZE_PATHOLOGICAL_TEXT));
  });
});

summary(() => {
  bench('scan-only: same-size plain token-density stress (~8 KB)', () => {
    do_not_optimize(drainTokenizerScanOnly(SAME_SIZE_PLAIN_TOKEN_DENSITY_STRESS_TEXT));
  });
});

summary(() => {
  for (const [index, input] of PLAIN_TEXT_INPUTS.entries()) {
    bench(`tokenize: plain text ${index + 1} (9 KB)`, () => {
      do_not_optimize(drainTokenize(input));
    }).gc('inner');
  }

  for (const [index, input] of PLAIN_TOKEN_DENSITY_STRESS_INPUTS.entries()) {
    bench(`tokenize: plain text token-density stress ${index + 1} (9 KB)`, () => {
      do_not_optimize(drainTokenize(input));
    }).gc('inner');
  }
});

summary(() => {
  bench(SAME_SIZE_PLAIN_LABEL, () => {
    do_not_optimize(drainTokenize(SAME_SIZE_PLAIN_TEXT));
  }).gc('inner');

  bench(SAME_SIZE_MIXED_LABEL, () => {
    do_not_optimize(drainTokenize(SAME_SIZE_MIXED_TEXT));
  }).gc('inner');

  bench(SAME_SIZE_PATHOLOGICAL_LABEL, () => {
    do_not_optimize(drainTokenize(SAME_SIZE_PATHOLOGICAL_TEXT));
  }).gc('inner');
});

summary(() => {
  bench(SAME_SIZE_PLAIN_TOKEN_DENSITY_STRESS_LABEL, () => {
    do_not_optimize(drainTokenize(SAME_SIZE_PLAIN_TOKEN_DENSITY_STRESS_TEXT));
  }).gc('inner');
});

summary(() => {
  for (const fixture of UNICODE_BENCH_FIXTURES) {
    bench(`tokenize: unicode ${fixture.key} (~8 KB)`, () => {
      do_not_optimize(drainTokenize(fixture.text_input));
    }).gc('inner');
  }
});

await run();