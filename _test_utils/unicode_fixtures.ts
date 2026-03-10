/**
 * Representative Unicode text classes used by tests and benchmarks.
 *
 * The goal is not to enumerate every code point. The goal is to cover the
 * classes of text that tend to break parser assumptions:
 *
 * - combining marks
 * - hidden format controls
 * - confusable letter shapes
 * - astral emoji and ZWJ sequences
 * - CJK text
 * - Arabic / RTL text
 * - Egyptian hieroglyphs
 * - kaomoji / fullwidth symbol-heavy text
 * - bidi marks mixed with visible text
 *
 * Keeping these fixtures in one place makes the test and benchmark story stay
 * aligned. When a new class is added here, it can be exercised across both
 * correctness and performance coverage.
 */

/** One representative Unicode text class. */
export interface UnicodeTextFixture {
  /** Stable short key for test names and benchmark labels. */
  readonly key: string;
  /** Human-readable label for reports. */
  readonly label: string;
  /** Compact sample that should stay plain text to the tokenizer. */
  readonly sample: string;
}

/**
 * Unicode text classes that should remain valid payload text throughout the
 * parser pipeline.
 */
export const UNICODE_TEXT_FIXTURES: readonly UnicodeTextFixture[] = [
  {
    key: 'combining-marks',
    label: 'combining marks',
    sample: 'Cafe\u0301nai\u0308veZ\u0323a\u0301lgo',
  },
  {
    key: 'hidden-format-controls',
    label: 'hidden format controls',
    sample: 'alpha\u200Bbeta\u200Cgamma\u200Ddelta\u2060omega\uFEFFend',
  },
  {
    key: 'confusable-letters',
    label: 'confusable letters',
    sample: 'раураlΑlphaСodeοrn',
  },
  {
    key: 'emoji-zwj',
    label: 'emoji and ZWJ sequences',
    sample: '👩🏽‍🚀👨‍👩‍👧‍👦🏳️‍🌈☕️',
  },
  {
    key: 'cjk',
    label: 'CJK text',
    sample: '日本語かな交じり文漢字テスト',
  },
  {
    key: 'arabic',
    label: 'Arabic RTL text',
    sample: 'مرحبابالعالمكيفالحال',
  },
  {
    key: 'egyptian-hieroglyphs',
    label: 'Egyptian hieroglyphs',
    sample: '𓀀𓁐𓂀𓃀𓆣',
  },
  {
    key: 'kaomoji-fullwidth',
    label: 'kaomoji and fullwidth symbols',
    sample: '（＾ω＾）人（＾∀＾）ノ',
  },
  {
    key: 'bidi-marks',
    label: 'bidi marks mixed with text',
    sample: 'abc\u200Fمرحبا\u200Exyz',
  },
] as const;