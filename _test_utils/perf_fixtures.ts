import type { WikitextEvent } from '../events.ts';

import {
  blockEvents,
  buildTree,
  createSession,
  events,
  inlineEvents,
  outlineEvents,
  parse,
  tokenize,
} from '../mod.ts';
import { UNICODE_TEXT_FIXTURES } from './unicode_fixtures.ts';

const CC_LF = 0x0a;
const CC_CR = 0x0d;
const CC_TAB = 0x09;
const CC_SPACE = 0x20;
const CC_BANG = 0x21;
const CC_HASH = 0x23;
const CC_AMP = 0x26;
const CC_APOSTROPHE = 0x27;
const CC_ASTERISK = 0x2a;
const CC_DASH = 0x2d;
const CC_SLASH = 0x2f;
const CC_COLON = 0x3a;
const CC_SEMICOLON = 0x3b;
const CC_LT = 0x3c;
const CC_EQUALS = 0x3d;
const CC_GT = 0x3e;
const CC_OPEN_BRACKET = 0x5b;
const CC_CLOSE_BRACKET = 0x5d;
const CC_UNDERSCORE = 0x5f;
const CC_OPEN_BRACE = 0x7b;
const CC_PIPE = 0x7c;
const CC_CLOSE_BRACE = 0x7d;
const CC_TILDE = 0x7e;

export type RangeState = {
  get(name: string): number;
};

export function repeatBlock(unit: string, repeat: number): string {
  return unit.repeat(repeat);
}

export function repeatToMinimumSize(unit: string, minimum_size: number): string {
  const repeat = Math.ceil(minimum_size / unit.length);
  return unit.repeat(repeat);
}

export function cycleInputs<T>(inputs: readonly T[]): () => T {
  let index = 0;

  return () => {
    const input = inputs[index];
    index = (index + 1) % inputs.length;
    return input;
  };
}

const PLAIN_PARAGRAPH_UNITS = [
  [
    'Observational astronomy records atmospheric scattering, continental weathering, and navigational corrections across multiple expeditions.',
    'Field notes preserve calibration details, seasonal drift, and cross-check remarks so later readers can reconstruct the original measurement context.',
  ].join(' '),
  [
    'Archival restoration teams compare transcription variants, publication histories, and editorial interventions before they publish a stable reference text.',
    'That workflow emphasizes provenance, reproducibility, and careful language around uncertainty instead of collapsing every disagreement into one canonical sentence.',
  ].join(' '),
  [
    'Long-form technical prose often mixes descriptive paragraphs, cautious qualifications, and domain-specific terminology while still remaining ordinary text to the tokenizer.',
    'This fixture aims to model that kind of paragraph payload rather than a short pangram repeated until the benchmark reaches its target size.',
  ].join(' '),
] as const;

const PLAIN_WORD_BOUNDARY_STRESS_UNIT = [
  'a a a a a a a a a a a a a a a a',
  'b b b b b b b b b b b b b b b b',
  'c c c c c c c c c c c c c c c c',
].join(' ');

export function repeatParagraphText(unit: string, minimum_size: number): string {
  return repeatToMinimumSize(`${unit}\n\n`, minimum_size);
}

export function repeatWordBoundaryStressText(minimum_size: number): string {
  return repeatToMinimumSize(`${PLAIN_WORD_BOUNDARY_STRESS_UNIT}\n`, minimum_size);
}

export const TOKENIZER_SCAN_DELIMITER = Uint8Array.from({ length: 128 }, (_, code) => {
  switch (code) {
    case CC_LF:
    case CC_CR:
    case CC_TAB:
    case CC_SPACE:
    case CC_BANG:
    case CC_HASH:
    case CC_AMP:
    case CC_APOSTROPHE:
    case CC_ASTERISK:
    case CC_DASH:
    case CC_SLASH:
    case CC_COLON:
    case CC_SEMICOLON:
    case CC_LT:
    case CC_EQUALS:
    case CC_GT:
    case CC_OPEN_BRACKET:
    case CC_CLOSE_BRACKET:
    case CC_UNDERSCORE:
    case CC_OPEN_BRACE:
    case CC_PIPE:
    case CC_CLOSE_BRACE:
    case CC_TILDE:
      return 1;

    default:
      return 0;
  }
});

export const PLAIN_TEXT_INPUTS = [
  repeatParagraphText(PLAIN_PARAGRAPH_UNITS[0], 9 * 1024),
  repeatParagraphText(PLAIN_PARAGRAPH_UNITS[1], 9 * 1024),
  repeatParagraphText(PLAIN_PARAGRAPH_UNITS[2], 9 * 1024),
] as const;

export const PLAIN_TOKEN_DENSITY_STRESS_INPUTS = [
  repeatWordBoundaryStressText(9 * 1024),
  repeatToMinimumSize(`${PLAIN_WORD_BOUNDARY_STRESS_UNIT}\t${PLAIN_WORD_BOUNDARY_STRESS_UNIT}\n`, 9 * 1024),
] as const;

export const HEADING_TEXT_INPUTS = [
  '== Section ==\nParagraph text here.\n'.repeat(100),
  '=== Nested ===\nAnother paragraph line.\n'.repeat(90),
] as const;

export const TABLE_TEXT_INPUTS = [
  '{|\n! H1 !! H2\n|-\n| A || B\n|-\n| C || D\n|}\n'.repeat(50),
  '{| class="wikitable"\n! Name !! Value\n|-\n| Alpha || 1\n|-\n| Beta || 2\n|}\n'.repeat(40),
] as const;

export const LINK_TEXT_INPUTS = [
  "See [[Main Page|home]], '''bold''' and ''italic'' text.\n".repeat(100),
  'Visit [[Earth|planet]] with [https://example.com source] and &amp; notes.\n'.repeat(80),
] as const;

export const TEMPLATE_TEXT_INPUTS = [
  '{{Infobox|name={{{1}}}|value={{{2|default}}}}}\n'.repeat(100),
  '{{Card|title={{PAGENAME}}|body={{{content|fallback}}}}}\n'.repeat(85),
] as const;

export const MIXED_TEXT_INPUTS = [
  [
    '== Heading ==',
    "'''Bold''' and ''italic'' and '''''both'''''.",
    '* Bullet item',
    '# Ordered item',
    ': Indented',
    '{|',
    '! Header',
    '|-',
    '| [[Page|link]] || {{template|arg=val}}',
    '|}',
    '----',
    '<!-- comment -->',
    '&amp; &#123; &#x1F4A9;',
    '~~~~ __TOC__',
    '',
  ].join('\n').repeat(50),
  [
    '== Another Heading ==',
    "A [[Main Page|home]] link with ''italic'' and '''bold'''.",
    '; Term',
    ': Definition',
    '{|',
    '! Name !! Count',
    '|-',
    '| {{Item|name=Alpha}} || 42',
    '|}',
    '<span class="lead">inline</span>',
    '&lt;escaped&gt; ~~ ~~ __TOC__',
    '',
  ].join('\n').repeat(48),
] as const;

export const PATHOLOGICAL_TEXT_INPUTS = [
  [
    '[[[[{{{{<!--',
    '__BROKEN_',
    '<ref name="n">',
    "'''''",
    '&broken',
    '```md',
    '{|',
    '|-',
    '| [[Page|{{T|x}}]] || <span class="x">text',
    '',
  ].join('\n').repeat(70),
  [
    '{{{{{{',
    '[[File:Example.jpg|thumb|{{Card|name=[[Main Page|home]]}}]]',
    '<nowiki>[[literal]] {{literal}}</nowiki>',
    '<!-- unclosed comment opener',
    '~~~~ __BROKEN_',
    '|| !! | |}',
    '',
  ].join('\n').repeat(55),
] as const;

export const INLINE_HEAVY_TEXT_INPUTS = [
  [
    '== References ==',
    "A [[Main Page|home]] link with ''italic'', '''bold''', and '''''both'''''.",
    '<ref name="cite-1" group="note">Example &amp; entity</ref>',
    '<span class="lead">inline tag</span> and <br/> break.',
    '__TOC__ {{Infobox|name=value|title={{{1|Default}}}}}',
    'A <nowiki>[[literal]] {{literal}}</nowiki> segment.',
    '',
  ].join('\n').repeat(80),
  [
    '== Inline ==',
    '[[Main Page|home]] [https://example.com ref] {{Card|name=value|body=<span>ok</span>}}',
    '<ref name="cite-2">\'\'quoted\'\' &amp; entity</ref>',
    'A <nowiki>[[literal]]</nowiki> block with __TOC__ nearby.',
    '',
  ].join('\n').repeat(90),
] as const;

export const SAME_SIZE_PLAIN_TEXT = repeatParagraphText(
  [
    'Reference documentation for event-driven parsers usually spends more bytes on terminology, examples, and caveats than on symbolic punctuation.',
    'That kind of paragraph prose is still plain text, but it has longer average word length and fewer extreme token boundaries per kilobyte than the old pangram fixture.',
  ].join(' '),
  8 * 1024,
);

export const SAME_SIZE_PLAIN_TOKEN_DENSITY_STRESS_TEXT = repeatWordBoundaryStressText(8 * 1024);

export const SAME_SIZE_MIXED_TEXT = repeatBlock([
  '== Heading ==',
  "A [[Main Page|home]] link with ''italic'' and '''bold'''.",
  '* Bullet item',
  '{|',
  '! Header !! Count',
  '|-',
  '| {{Item|name=Alpha}} || 42',
  '|}',
  '&amp; __TOC__',
  '',
].join('\n'), 24);

export const SAME_SIZE_PATHOLOGICAL_TEXT = repeatBlock([
  '[[[[{{{{<!--',
  '__BROKEN_',
  '<ref name="n">',
  "'''''",
  '&broken',
  '```md',
  '{|',
  '| [[Page|{{T|x}}]] || <span class="x">text',
  '',
].join('\n'), 30);

export type UnicodeBenchFixture = {
  key: string;
  label: string;
  text_input: string;
  document_input: string;
};

function createUnicodeBenchFixture(
  fixture: (typeof UNICODE_TEXT_FIXTURES)[number],
): UnicodeBenchFixture {
  const text_input = repeatToMinimumSize(`${fixture.sample}`, 8 * 1024);
  const document_unit = [
    `== ${fixture.sample} ==`,
    fixture.sample,
    `* ${fixture.sample}`,
    '',
  ].join('\n');

  return {
    key: fixture.key,
    label: fixture.label,
    text_input,
    document_input: repeatToMinimumSize(`${document_unit}\n`, 8 * 1024),
  };
}

export const UNICODE_BENCH_FIXTURES = UNICODE_TEXT_FIXTURES.map(createUnicodeBenchFixture);

export const SYNTHETIC_ARTICLE_INPUTS = [
  repeatBlock([
    '{{Infobox settlement|name=Example City|population_total=123456|map={{Location map|World}}}}',
    '== Lead ==',
    "Example City is a ''fictional'' place with [[Main Page|notable links]], references, and templates.",
    '== History ==',
    '* Founded in 1901',
    '* Expanded with {{Convert|25|km|mi}} of rail',
    '== Geography ==',
    '{| class="wikitable"',
    '! District !! Population',
    '|-',
    '| North || 42000',
    '|-',
    '| South || 38000',
    '|}',
    '== Culture ==',
    '<ref name="cite-1">A cited note with &amp; entity</ref>',
    '<span class="lead">Inline tag</span> with __TOC__ and <br/> break.',
    '',
  ].join('\n'), 48),
  repeatBlock([
    '{{Infobox person|name=Example Person|occupation=Writer|known_for=[[Sample work]]}}',
    '== Summary ==',
    "Example Person wrote about [[Earth|the world]], ''style'', and '''emphasis'''.",
    '== Works ==',
    '# First book',
    '# Second book with {{Smallcaps|Title}}',
    '== Notes ==',
    '; Theme',
    ': Mixed prose with [https://example.com source] and <ref group="note">footnote</ref>.',
    '== Data ==',
    '{| class="wikitable"',
    '! Year !! Work',
    '|-',
    '| 2001 || [[Alpha]]',
    '|-',
    '| 2007 || [[Beta]]',
    '|}',
    '',
  ].join('\n'), 52),
] as const;

export const LARGE_FILE_MINIMUM_SIZE = 100 * 1024 * 1024;

const LARGE_STREAMING_ARTICLE_UNIT = [
  '== Lead ==',
  "A [[Main Page|home]] link with ''italic'', '''bold''', and {{Card|name=value|body={{Nested|x=1}}}}.",
  '* Bullet item with [https://example.com source] and &amp; entity.',
  '# Ordered item with <ref name="cite-1">inline reference text</ref>.',
  '{| class="wikitable"',
  '! Name !! Value',
  '|-',
  '| Alpha || [[Page|Display]]',
  '|-',
  '| Beta || {{Template|arg=value|body=<span class="x">inline</span>}}',
  '|}',
  '<nowiki>[[literal]] {{literal}}</nowiki>',
  '__TOC__ ~~~~',
  '',
].join('\n');

export const LARGE_STREAMING_ARTICLE_TEXT = repeatToMinimumSize(
  `${LARGE_STREAMING_ARTICLE_UNIT}\n`,
  LARGE_FILE_MINIMUM_SIZE,
);

export function drainTokenize(input: string): number {
  let count = 0;
  for (const _tok of tokenize(input)) {
    count++;
  }
  return count;
}

export function drainTokenizerScanOnly(input: string): number {
  let checksum = 0;

  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    checksum += code;

    if (code < 128 && TOKENIZER_SCAN_DELIMITER[code]) {
      checksum ^= index;
    }
  }

  return checksum;
}

export function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }

  return `${count}`;
}

export function countTokenizerDelimiters(input: string): number {
  let count = 0;

  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code < 128 && TOKENIZER_SCAN_DELIMITER[code]) {
      count++;
    }
  }

  return count;
}

export function describeTokenizeFixture(name: string, input: string): string {
  const token_count = drainTokenize(input);
  const emitted_tokens = Math.max(token_count - 1, 0);
  const chars_per_token = emitted_tokens === 0
    ? '0.00'
    : (input.length / emitted_tokens).toFixed(2);
  const delimiter_count = countTokenizerDelimiters(input);
  const delimiters_per_kb = ((delimiter_count * 1024) / input.length).toFixed(1);

  return `${name}, ${formatTokenCount(emitted_tokens)} tokens, ${chars_per_token} chars/token, ${delimiters_per_kb} delimiters/KB`;
}

export function drainBlockEvents(input: string): number {
  let count = 0;
  for (const _event of blockEvents(input, tokenize(input))) {
    count++;
  }
  return count;
}

export function drainInlineEvents(input: string): number {
  let count = 0;
  for (const _event of inlineEvents(input, blockEvents(input, tokenize(input)))) {
    count++;
  }
  return count;
}

export type TreeBuildFixture = {
  source: string;
  events: WikitextEvent[];
};

export type OutlineTreeBuildFixture = {
  source: string;
  events: WikitextEvent[];
};

export function createTreeBuildFixture(source: string): TreeBuildFixture {
  return {
    source,
    events: Array.from(inlineEvents(source, blockEvents(source, tokenize(source)))),
  };
}

export function createOutlineTreeBuildFixture(source: string): OutlineTreeBuildFixture {
  return {
    source,
    events: Array.from(outlineEvents(source)),
  };
}

export function drainBuildTreeFromEvents(fixture: TreeBuildFixture): number {
  const tree = buildTree(fixture.events, { source: fixture.source });
  return tree.children.length;
}

export function drainBuildTreeFromOutline(fixture: OutlineTreeBuildFixture): number {
  const tree = buildTree(fixture.events, { source: fixture.source });
  return tree.children.length;
}

export function drainStatelessLayeredWorkflow(source: string): number {
  const outline_count = Array.from(outlineEvents(source)).length;
  const full_event_count = Array.from(events(source)).length;
  const tree_child_count = parse(source).children.length;

  return outline_count + full_event_count + tree_child_count;
}

export function drainSessionLayeredWorkflowCold(source: string): number {
  const session = createSession(source);
  const outline_count = Array.from(session.outline()).length;
  const full_event_count = Array.from(session.events()).length;
  const tree_child_count = session.parse().children.length;

  return outline_count + full_event_count + tree_child_count;
}

export function drainSessionLayeredWorkflowWarm(source: string): number {
  const session = createSession(source);
  Array.from(session.outline());
  Array.from(session.events());
  session.parse();

  const outline_count = Array.from(session.outline()).length;
  const full_event_count = Array.from(session.events()).length;
  const tree_child_count = session.parse().children.length;

  return outline_count + full_event_count + tree_child_count;
}

export function drainSessionOutlineWarm(source: string): number {
  const session = createSession(source);
  Array.from(session.outline());

  let count = 0;
  for (const _event of session.outline()) {
    count++;
  }
  return count;
}

export function drainSessionEventsWarm(source: string): number {
  const session = createSession(source);
  Array.from(session.events());

  let count = 0;
  for (const _event of session.events()) {
    count++;
  }
  return count;
}

export function drainSessionParseWarm(source: string): number {
  const session = createSession(source);
  session.parse();
  return session.parse().children.length;
}