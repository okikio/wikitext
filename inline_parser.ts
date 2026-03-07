/**
 * Inline event enrichment over block-parser text ranges.
 *
 * The block parser decides the large document shape: headings, paragraphs,
 * lists, tables, and other block nodes. It intentionally does not decide what
 * inline markup means inside those blocks. This module is the next stage. It
 * reads the block parser's text ranges and expands them into finer-grained
 * inline enter/exit/text events.
 *
 * This stage is still event-first. It does not build tree nodes directly.
 * Instead it emits the same event stream shape the future `events()` API and
 * tree builder will consume.
 *
 * Performance matters here. The block parser currently emits token-sized text
 * events, so this module first merges adjacent text spans before scanning them.
 * The scanner then works in absolute source offsets and uses `charCodeAt()`
 * directly. It only slices strings when a node actually needs a convenience
 * string field such as `target`, `name`, or `value`.
 *
 * The current implementation covers:
 * - apostrophe emphasis (`''`, `'''`, `'''''`)
 * - wikilinks, category links, and image links
 * - bracketed external links and bare URLs
 * - templates, parser functions, and triple-brace arguments
 * - comments, HTML entities, behavior switches, and signatures
 * - `<br>`, `<nowiki>`, `<ref>`, and generic HTML / extension tags
 *
 * Recovery rule: when a construct cannot be closed safely, it falls back to
 * plain text rather than throwing or inventing structure.
 *
 * @example Enriching block-level events with inline markup
 * ```ts
 * import { inlineEvents } from './inline_parser.ts';
 * import { blockEvents } from './block_parser.ts';
 * import { tokenize } from './tokenizer.ts';
 *
 * const source = "A [[Page|link]] with ''italic'' text.";
 * const events = [...inlineEvents(source, blockEvents(source, tokenize(source)))];
 * ```
 *
 * @module
 */

import type { TextSource } from './text_source.ts';
import type { Point, Position, TextEvent, WikitextEvent } from './events.ts';
import {
  enterEvent,
  exitEvent,
  textEvent,
} from './events.ts';

const CC_LF = 0x0a;
const CC_CR = 0x0d;
const CC_SPACE = 0x20;
const CC_TAB = 0x09;
const CC_HASH = 0x23;
const CC_AMP = 0x26;
const CC_APOSTROPHE = 0x27;
const CC_DASH = 0x2d;
const CC_SLASH = 0x2f;
const CC_COLON = 0x3a;
const CC_LT = 0x3c;
const CC_EQUALS = 0x3d;
const CC_GT = 0x3e;
const CC_OPEN_BRACKET = 0x5b;
const CC_CLOSE_BRACKET = 0x5d;
const CC_UNDERSCORE = 0x5f;
const CC_PIPE = 0x7c;
const CC_TILDE = 0x7e;
const CC_DOUBLE_QUOTE = 0x22;
const CC_SINGLE_QUOTE = 0x27;

interface TextGroupContext {
  source: TextSource;
  start_offset: number;
  end_offset: number;
  start_point: Point;
  line_starts: number[];
}

interface SpecialMatch {
  end_offset: number;
  events: WikitextEvent[];
}

interface TagOpen {
  tag_name: string;
  tag_name_lower: string;
  end_offset: number;
  self_closing: boolean;
  attributes?: Readonly<Record<string, string>>;
}

interface TagClose {
  tag_name_lower: string;
  end_offset: number;
}

interface TagBoundary {
  start_offset: number;
  end_offset: number;
}

/**
 * Enrich block-parser text spans with inline markup events.
 *
 * Consecutive text events are merged before scanning because the block parser
 * currently emits text one token at a time. Parsing each token in isolation
 * would miss multi-token constructs such as `[[link|text]]` and `{{template}}`.
 */
export function* inlineEvents(
  source: TextSource,
  events: Iterable<WikitextEvent>,
): Generator<WikitextEvent> {
  let pending_text: TextEvent[] = [];

  for (const event of events) {
    if (event.kind === 'text') {
      if (
        pending_text.length > 0 &&
        pending_text[pending_text.length - 1].end_offset !== event.start_offset
      ) {
        yield* parseTextGroup(source, pending_text);
        pending_text = [];
      }

      pending_text.push(event);
      continue;
    }

    if (pending_text.length > 0) {
      yield* parseTextGroup(source, pending_text);
      pending_text = [];
    }

    yield event;
  }

  if (pending_text.length > 0) {
    yield* parseTextGroup(source, pending_text);
  }
}

function* parseTextGroup(
  source: TextSource,
  events: TextEvent[],
): Generator<WikitextEvent> {
  const first = events[0];
  const last = events[events.length - 1];
  const ctx = createTextGroupContext(
    source,
    first.start_offset,
    last.end_offset,
    first.position.start,
  );

  yield* parseInlineRange(ctx, ctx.start_offset, ctx.end_offset, true);
}

/**
 * Parse one absolute source range.
 *
 * Plain text is emitted lazily only when a special construct is found or the
 * range ends.
 */
function* parseInlineRange(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  allow_bare_url: boolean,
): Generator<WikitextEvent> {
  let cursor = start_offset;
  let plain_start = start_offset;

  while (cursor < end_offset) {
    const match = matchSpecial(ctx, cursor, end_offset, allow_bare_url);
    if (match === null) {
      cursor++;
      continue;
    }

    if (plain_start < cursor) {
      yield emitText(ctx, plain_start, cursor);
    }

    for (const event of match.events) {
      yield event;
    }

    cursor = match.end_offset;
    plain_start = cursor;
  }

  if (plain_start < end_offset) {
    yield emitText(ctx, plain_start, end_offset);
  }
}

function matchSpecial(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
  allow_bare_url: boolean,
): SpecialMatch | null {
  return matchComment(ctx, cursor, end_offset) ??
    matchTagLike(ctx, cursor, end_offset) ??
    matchBehaviorSwitch(ctx, cursor, end_offset) ??
    matchSignature(ctx, cursor, end_offset) ??
    matchHtmlEntity(ctx, cursor, end_offset) ??
    matchArgument(ctx, cursor, end_offset) ??
    matchTemplate(ctx, cursor, end_offset) ??
    matchWikilink(ctx, cursor, end_offset) ??
    matchExternalLink(ctx, cursor, end_offset) ??
    (allow_bare_url ? matchBareUrl(ctx, cursor, end_offset) : null) ??
    matchEmphasis(ctx, cursor, end_offset);
}

function matchBehaviorSwitch(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (!hasLiteral(ctx.source, cursor, end_offset, '__')) return null;

  const name_start = cursor + 2;
  let probe = name_start;
  if (probe >= end_offset || !isAsciiLetter(ctx.source.charCodeAt(probe))) {
    return null;
  }

  probe++;
  while (probe < end_offset) {
    if (
      probe + 1 < end_offset &&
      ctx.source.charCodeAt(probe) === CC_UNDERSCORE &&
      ctx.source.charCodeAt(probe + 1) === CC_UNDERSCORE
    ) {
      const end = probe + 2;
      return {
        end_offset: end,
        events: wrapLeaf(ctx, cursor, end, 'behavior-switch', {
          name: ctx.source.slice(name_start, probe),
        }),
      };
    }

    const code = ctx.source.charCodeAt(probe);
    if (isAsciiLetter(code) || isAsciiDigit(code) || code === CC_UNDERSCORE) {
      probe++;
      continue;
    }
    return null;
  }

  return null;
}

function matchSignature(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (ctx.source.charCodeAt(cursor) !== CC_TILDE) return null;
  const run = repeatedCharRun(ctx.source, cursor, end_offset, CC_TILDE);
  if (run < 3 || run > 5) return null;
  if (cursor + run < end_offset && ctx.source.charCodeAt(cursor + run) === CC_TILDE) {
    return null;
  }

  return {
    end_offset: cursor + run,
    events: wrapLeaf(ctx, cursor, cursor + run, 'signature', {
      tildes: run as 3 | 4 | 5,
    }),
  };
}

function matchHtmlEntity(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (ctx.source.charCodeAt(cursor) !== CC_AMP) return null;

  let probe = cursor + 1;
  if (probe >= end_offset) return null;

  if (ctx.source.charCodeAt(probe) === CC_HASH) {
    probe++;
    if (
      probe < end_offset &&
      (ctx.source.charCodeAt(probe) === 0x78 || ctx.source.charCodeAt(probe) === 0x58)
    ) {
      probe++;
      const digits_start = probe;
      while (probe < end_offset && isHexDigit(ctx.source.charCodeAt(probe))) probe++;
      if (probe === digits_start) return null;
    } else {
      const digits_start = probe;
      while (probe < end_offset && isAsciiDigit(ctx.source.charCodeAt(probe))) probe++;
      if (probe === digits_start) return null;
    }
  } else {
    if (!isAsciiLetter(ctx.source.charCodeAt(probe))) return null;
    probe++;
    while (probe < end_offset && isAsciiAlphanumeric(ctx.source.charCodeAt(probe))) probe++;
  }

  if (probe >= end_offset || ctx.source.charCodeAt(probe) !== 0x3b) return null;
  const end = probe + 1;

  return {
    end_offset: end,
    events: wrapLeaf(ctx, cursor, end, 'html-entity', {
      value: ctx.source.slice(cursor, end),
    }),
  };
}

function matchComment(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (!hasLiteral(ctx.source, cursor, end_offset, '<!--')) return null;
  const close_start = indexOfLiteral(ctx.source, '-->', cursor + 4, end_offset);
  if (close_start === -1) return null;
  const end = close_start + 3;

  return {
    end_offset: end,
    events: wrapLeaf(ctx, cursor, end, 'comment', {
      value: ctx.source.slice(cursor + 4, close_start),
    }),
  };
}

function matchArgument(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (!hasLiteral(ctx.source, cursor, end_offset, '{{{')) return null;

  const close_end = findBalanced(ctx.source, cursor, end_offset, '{{{', '}}}');
  if (close_end === -1) return null;

  const inner_start = cursor + 3;
  const inner_end = close_end - 3;
  const pipe = firstTopLevelSeparator(ctx.source, inner_start, inner_end, CC_PIPE);
  const name_range = trimRange(ctx.source, inner_start, pipe === -1 ? inner_end : pipe);
  const name = ctx.source.slice(name_range.start, name_range.end);
  if (name.length === 0) return null;

  const props = pipe === -1
    ? { name }
    : {
      name,
      default: ctx.source.slice(...rangeTuple(trimRange(ctx.source, pipe + 1, inner_end))),
    };

  return {
    end_offset: close_end,
    events: wrapLeaf(ctx, cursor, close_end, 'argument', props),
  };
}

function matchTemplate(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (!hasLiteral(ctx.source, cursor, end_offset, '{{') || hasLiteral(ctx.source, cursor, end_offset, '{{{')) {
    return null;
  }

  const close_end = findBalanced(ctx.source, cursor, end_offset, '{{', '}}');
  if (close_end === -1) return null;

  const inner_start = cursor + 2;
  const inner_end = close_end - 2;
  const separators = topLevelSeparators(ctx.source, inner_start, inner_end, CC_PIPE);
  const head_end = separators.length === 0 ? inner_end : separators[0];
  const name_range = trimRange(ctx.source, inner_start, head_end);
  const name = ctx.source.slice(name_range.start, name_range.end);
  if (name.length === 0) return null;

  const node_type = name.startsWith('#') ? 'parser-function' : 'template';
  const outer_pos = createPosition(ctx, cursor, close_end);
  const events: WikitextEvent[] = [enterEvent(node_type, { name }, outer_pos)];

  for (let index = 0; index < separators.length; index++) {
    const arg_start = separators[index] + 1;
    const arg_end = index + 1 < separators.length ? separators[index + 1] : inner_end;
    events.push(...parseTemplateArgument(ctx, arg_start, arg_end));
  }

  events.push(exitEvent(node_type, outer_pos));
  return { end_offset: close_end, events };
}

function parseTemplateArgument(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
): WikitextEvent[] {
  const arg_pos = createPosition(ctx, start_offset, end_offset);
  const eq = topLevelEquals(ctx.source, start_offset, end_offset);
  const props = eq === -1
    ? {}
    : {
      name: ctx.source.slice(
        ...rangeTuple(trimRange(ctx.source, start_offset, eq)),
      ),
    };
  const value_start = eq === -1 ? start_offset : eq + 1;

  return [
    enterEvent('template-argument', props, arg_pos),
    ...collectInlineRange(ctx, value_start, end_offset, true),
    exitEvent('template-argument', arg_pos),
  ];
}

function matchWikilink(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (!hasLiteral(ctx.source, cursor, end_offset, '[[')) return null;

  const close_end = findBalanced(ctx.source, cursor, end_offset, '[[', ']]');
  if (close_end === -1) return null;

  const inner_start = cursor + 2;
  const inner_end = close_end - 2;
  const separators = topLevelSeparators(ctx.source, inner_start, inner_end, CC_PIPE);
  const target_end = separators.length === 0 ? inner_end : separators[0];
  let target_range = trimRange(ctx.source, inner_start, target_end);
  if (target_range.start === target_range.end) return null;

  let leading_colon = false;
  if (ctx.source.charCodeAt(target_range.start) === CC_COLON) {
    leading_colon = true;
    target_range = trimRange(ctx.source, target_range.start + 1, target_range.end);
  }

  const target = ctx.source.slice(target_range.start, target_range.end);
  const target_lower = target.toLowerCase();
  if (!leading_colon && target_lower.startsWith('category:')) {
    const sort_key = separators.length === 0
      ? undefined
      : ctx.source.slice(
        ...rangeTuple(trimRange(ctx.source, separators[0] + 1, inner_end)),
      );
    const props = sort_key === undefined || sort_key.length === 0
      ? { target }
      : { target, sort_key };
    return {
      end_offset: close_end,
      events: wrapLeaf(ctx, cursor, close_end, 'category-link', props),
    };
  }

  const node_type = !leading_colon && (target_lower.startsWith('file:') || target_lower.startsWith('image:'))
    ? 'image-link'
    : 'wikilink';
  const outer_pos = createPosition(ctx, cursor, close_end);
  const events: WikitextEvent[] = [enterEvent(node_type, { target }, outer_pos)];

  if (separators.length > 0) {
    events.push(...collectInlineRange(ctx, separators[0] + 1, inner_end, false));
  }

  events.push(exitEvent(node_type, outer_pos));
  return { end_offset: close_end, events };
}

function matchExternalLink(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (ctx.source.charCodeAt(cursor) !== CC_OPEN_BRACKET || hasLiteral(ctx.source, cursor, end_offset, '[[')) {
    return null;
  }

  const close = indexOfChar(ctx.source, CC_CLOSE_BRACKET, cursor + 1, end_offset);
  if (close === -1) return null;

  const url_end = scanUrl(ctx.source, cursor + 1, close);
  if (url_end === cursor + 1) return null;
  const url = ctx.source.slice(cursor + 1, url_end);
  const outer_end = close + 1;
  const outer_pos = createPosition(ctx, cursor, outer_end);
  const events: WikitextEvent[] = [enterEvent('external-link', { url }, outer_pos)];

  let label_start = url_end;
  while (label_start < close) {
    const code = ctx.source.charCodeAt(label_start);
    if (code !== CC_SPACE && code !== CC_TAB) break;
    label_start++;
  }

  if (label_start < close) {
    events.push(...collectInlineRange(ctx, label_start, close, false));
  }

  events.push(exitEvent('external-link', outer_pos));
  return { end_offset: outer_end, events };
}

function matchBareUrl(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  const url_end = scanUrl(ctx.source, cursor, end_offset);
  if (url_end === cursor) return null;
  const url = ctx.source.slice(cursor, url_end);
  const pos = createPosition(ctx, cursor, url_end);
  return {
    end_offset: url_end,
    events: [
      enterEvent('external-link', { url }, pos),
      exitEvent('external-link', pos),
    ],
  };
}

function matchEmphasis(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (ctx.source.charCodeAt(cursor) !== CC_APOSTROPHE) return null;
  const run = repeatedCharRun(ctx.source, cursor, end_offset, CC_APOSTROPHE);
  if (run < 2) return null;

  if (run === 4) {
    const bold = matchDelimitedInline(ctx, cursor + 1, end_offset, 3, 'bold');
    if (bold === null) return null;
    return {
      end_offset: bold.end_offset,
      events: [emitText(ctx, cursor, cursor + 1), ...bold.events],
    };
  }

  if (run >= 5) {
    return matchDelimitedInline(ctx, cursor, end_offset, 5, 'bold-italic');
  }
  if (run === 3) {
    return matchDelimitedInline(ctx, cursor, end_offset, 3, 'bold');
  }
  return matchDelimitedInline(ctx, cursor, end_offset, 2, 'italic');
}

function matchDelimitedInline(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
  marker_length: number,
  node_type: string,
): SpecialMatch | null {
  const content_start = cursor + marker_length;
  const line_end = findLineEnd(ctx.source, content_start, end_offset);
  const close_start = findApostropheClose(ctx.source, content_start, line_end, marker_length);
  const content_end = close_start === -1 ? line_end : close_start;
  const close_end = close_start === -1 ? line_end : close_start + marker_length;
  const outer_pos = createPosition(ctx, cursor, close_end);

  return {
    end_offset: close_end,
    events: [
      enterEvent(node_type, {}, outer_pos),
      ...collectInlineRange(ctx, content_start, content_end, true),
      exitEvent(node_type, outer_pos),
    ],
  };
}

function matchTagLike(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (ctx.source.charCodeAt(cursor) !== CC_LT) return null;
  if (hasLiteral(ctx.source, cursor, end_offset, '<!--')) return null;

  const tag = parseTagOpen(ctx.source, cursor, end_offset);
  if (tag === null) return null;

  if (tag.tag_name_lower === 'br') {
    return {
      end_offset: tag.end_offset,
      events: wrapLeaf(ctx, cursor, tag.end_offset, 'break', {}),
    };
  }

  if (tag.tag_name_lower === 'nowiki') {
    if (tag.self_closing) {
      return {
        end_offset: tag.end_offset,
        events: wrapLeaf(ctx, cursor, tag.end_offset, 'nowiki', { value: '' }),
      };
    }

    const close = findMatchingCloseTag(ctx.source, tag, tag.end_offset, end_offset);
    if (close === null) return null;
    return {
      end_offset: close.end_offset,
      events: wrapLeaf(ctx, cursor, close.end_offset, 'nowiki', {
        value: ctx.source.slice(tag.end_offset, close.start_offset),
      }),
    };
  }

  if (tag.tag_name_lower === 'ref') {
    const ref_props = referenceProps(tag.attributes);
    if (tag.self_closing) {
      return {
        end_offset: tag.end_offset,
        events: wrapLeaf(ctx, cursor, tag.end_offset, 'reference', ref_props),
      };
    }

    const close = findMatchingCloseTag(ctx.source, tag, tag.end_offset, end_offset);
    if (close === null) return null;
    const outer_pos = createPosition(ctx, cursor, close.end_offset);
    return {
      end_offset: close.end_offset,
      events: [
        enterEvent('reference', ref_props, outer_pos),
        ...collectInlineRange(ctx, tag.end_offset, close.start_offset, true),
        exitEvent('reference', outer_pos),
      ],
    };
  }

  const html_props = tag.attributes === undefined
    ? { tag_name: tag.tag_name, self_closing: tag.self_closing }
    : { tag_name: tag.tag_name, self_closing: tag.self_closing, attributes: tag.attributes };

  if (tag.self_closing) {
    return {
      end_offset: tag.end_offset,
      events: wrapLeaf(ctx, cursor, tag.end_offset, 'html-tag', html_props),
    };
  }

  const close = findMatchingCloseTag(ctx.source, tag, tag.end_offset, end_offset);
  if (close === null) return null;
  const outer_pos = createPosition(ctx, cursor, close.end_offset);
  return {
    end_offset: close.end_offset,
    events: [
      enterEvent('html-tag', html_props, outer_pos),
      ...collectInlineRange(ctx, tag.end_offset, close.start_offset, true),
      exitEvent('html-tag', outer_pos),
    ],
  };
}

/**
 * Record only line-start offsets for a text group.
 *
 * A `Point` per code unit would be easy to use but too expensive for a hot
 * parser path. Integer line starts are enough to reconstruct positions on
 * demand.
 */
function createTextGroupContext(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  start_point: Point,
): TextGroupContext {
  const line_starts = [start_offset];
  let cursor = start_offset;

  while (cursor < end_offset) {
    const code = source.charCodeAt(cursor);
    if (code === CC_CR) {
      cursor++;
      if (cursor < end_offset && source.charCodeAt(cursor) === CC_LF) cursor++;
      if (cursor < end_offset) line_starts.push(cursor);
      continue;
    }
    if (code === CC_LF) {
      cursor++;
      if (cursor < end_offset) line_starts.push(cursor);
      continue;
    }
    cursor++;
  }

  return { source, start_offset, end_offset, start_point, line_starts };
}

function emitText(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
): WikitextEvent {
  return textEvent(start_offset, end_offset, createPosition(ctx, start_offset, end_offset));
}

function wrapLeaf(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  node_type: string,
  props: Readonly<Record<string, unknown>>,
): WikitextEvent[] {
  const position = createPosition(ctx, start_offset, end_offset);
  return [enterEvent(node_type, props, position), exitEvent(node_type, position)];
}

function collectInlineRange(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  allow_bare_url: boolean,
): WikitextEvent[] {
  return Array.from(parseInlineRange(ctx, start_offset, end_offset, allow_bare_url));
}

function createPosition(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
): Position {
  return {
    start: pointAt(ctx, start_offset),
    end: pointAt(ctx, end_offset),
  };
}

function pointAt(ctx: TextGroupContext, offset: number): Point {
  const line_index = lineIndexAt(ctx.line_starts, offset);
  if (line_index === 0) {
    return {
      line: ctx.start_point.line,
      column: ctx.start_point.column + (offset - ctx.start_offset),
      offset,
    };
  }

  const line_start = ctx.line_starts[line_index];
  return {
    line: ctx.start_point.line + line_index,
    column: 1 + (offset - line_start),
    offset,
  };
}

function lineIndexAt(line_starts: number[], offset: number): number {
  let low = 0;
  let high = line_starts.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (line_starts[mid] <= offset) {
      if (mid === line_starts.length - 1 || line_starts[mid + 1] > offset) {
        return mid;
      }
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return 0;
}

function findBalanced(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let cursor = start_offset;

  while (cursor < end_offset) {
    if (hasLiteral(source, cursor, end_offset, open)) {
      depth++;
      cursor += open.length;
      continue;
    }
    if (hasLiteral(source, cursor, end_offset, close)) {
      depth--;
      cursor += close.length;
      if (depth === 0) return cursor;
      continue;
    }
    cursor++;
  }

  return -1;
}

function topLevelSeparators(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  separator: number,
): number[] {
  const result: number[] = [];
  let depth_square = 0;
  let depth_template = 0;
  let depth_argument = 0;

  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    if (hasLiteral(source, cursor, end_offset, '{{{')) {
      depth_argument++;
      cursor += 2;
      continue;
    }
    if (hasLiteral(source, cursor, end_offset, '}}}')) {
      if (depth_argument > 0) depth_argument--;
      cursor += 2;
      continue;
    }
    if (hasLiteral(source, cursor, end_offset, '{{')) {
      depth_template++;
      cursor += 1;
      continue;
    }
    if (hasLiteral(source, cursor, end_offset, '}}')) {
      if (depth_template > 0) depth_template--;
      cursor += 1;
      continue;
    }
    if (hasLiteral(source, cursor, end_offset, '[[')) {
      depth_square++;
      cursor += 1;
      continue;
    }
    if (hasLiteral(source, cursor, end_offset, ']]')) {
      if (depth_square > 0) depth_square--;
      cursor += 1;
      continue;
    }

    if (
      source.charCodeAt(cursor) === separator &&
      depth_square === 0 &&
      depth_template === 0 &&
      depth_argument === 0
    ) {
      result.push(cursor);
    }
  }

  return result;
}

function firstTopLevelSeparator(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  separator: number,
): number {
  const separators = topLevelSeparators(source, start_offset, end_offset, separator);
  return separators.length === 0 ? -1 : separators[0];
}

function topLevelEquals(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): number {
  return firstTopLevelSeparator(source, start_offset, end_offset, CC_EQUALS);
}

function trimRange(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): { start: number; end: number } {
  let start = start_offset;
  let end = end_offset;

  while (start < end) {
    const code = source.charCodeAt(start);
    if (code !== CC_SPACE && code !== CC_TAB && code !== CC_LF && code !== CC_CR) break;
    start++;
  }

  while (end > start) {
    const code = source.charCodeAt(end - 1);
    if (code !== CC_SPACE && code !== CC_TAB && code !== CC_LF && code !== CC_CR) break;
    end--;
  }

  return { start, end };
}

function rangeTuple(range: { start: number; end: number }): [number, number] {
  return [range.start, range.end];
}

function findLineEnd(source: TextSource, start_offset: number, end_offset: number): number {
  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    const code = source.charCodeAt(cursor);
    if (code === CC_LF || code === CC_CR) return cursor;
  }
  return end_offset;
}

function findApostropheClose(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  marker_length: number,
): number {
  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    if (source.charCodeAt(cursor) !== CC_APOSTROPHE) continue;
    if (repeatedCharRun(source, cursor, end_offset, CC_APOSTROPHE) >= marker_length) {
      return cursor;
    }
  }
  return -1;
}

function parseTagOpen(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): TagOpen | null {
  if (source.charCodeAt(start_offset) !== CC_LT) return null;
  let cursor = start_offset + 1;
  if (cursor >= end_offset || !isTagNameStart(source.charCodeAt(cursor))) return null;

  const name_start = cursor;
  cursor++;
  while (cursor < end_offset && isTagNameChar(source.charCodeAt(cursor))) cursor++;
  const name_end = cursor;

  let quote = 0;
  let self_closing = false;
  while (cursor < end_offset) {
    const code = source.charCodeAt(cursor);
    if (quote !== 0) {
      if (code === quote) quote = 0;
      cursor++;
      continue;
    }
    if (code === CC_DOUBLE_QUOTE || code === CC_SINGLE_QUOTE) {
      quote = code;
      cursor++;
      continue;
    }
    if (code === CC_GT) {
      const attr_end = self_closing ? cursor - 1 : cursor;
      const tag_name = source.slice(name_start, name_end);
      const attributes = parseAttributes(source, name_end, attr_end);
      return {
        tag_name,
        tag_name_lower: tag_name.toLowerCase(),
        end_offset: cursor + 1,
        self_closing,
        attributes,
      };
    }
    self_closing = code === CC_SLASH;
    cursor++;
  }

  return null;
}

function parseClosingTag(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): TagClose | null {
  if (!hasLiteral(source, start_offset, end_offset, '</')) return null;
  let cursor = start_offset + 2;
  if (cursor >= end_offset || !isTagNameStart(source.charCodeAt(cursor))) return null;

  const name_start = cursor;
  cursor++;
  while (cursor < end_offset && isTagNameChar(source.charCodeAt(cursor))) cursor++;
  const name_end = cursor;

  while (cursor < end_offset) {
    const code = source.charCodeAt(cursor);
    if (code === CC_SPACE || code === CC_TAB || code === CC_LF || code === CC_CR) {
      cursor++;
      continue;
    }
    break;
  }

  if (cursor >= end_offset || source.charCodeAt(cursor) !== CC_GT) return null;
  return {
    tag_name_lower: source.slice(name_start, name_end).toLowerCase(),
    end_offset: cursor + 1,
  };
}

function findMatchingCloseTag(
  source: TextSource,
  open_tag: TagOpen,
  start_offset: number,
  end_offset: number,
): TagBoundary | null {
  let cursor = start_offset;
  let depth = 0;

  while (cursor < end_offset) {
    if (hasLiteral(source, cursor, end_offset, '<!--')) {
      const close = indexOfLiteral(source, '-->', cursor + 4, end_offset);
      cursor = close === -1 ? end_offset : close + 3;
      continue;
    }

    const close_tag = parseClosingTag(source, cursor, end_offset);
    if (close_tag !== null && close_tag.tag_name_lower === open_tag.tag_name_lower) {
      if (depth === 0) {
        return { start_offset: cursor, end_offset: close_tag.end_offset };
      }
      depth--;
      cursor = close_tag.end_offset;
      continue;
    }

    const nested_open = parseTagOpen(source, cursor, end_offset);
    if (nested_open !== null && nested_open.tag_name_lower === open_tag.tag_name_lower) {
      if (!nested_open.self_closing) depth++;
      cursor = nested_open.end_offset;
      continue;
    }

    cursor++;
  }

  return null;
}

function parseAttributes(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): Readonly<Record<string, string>> | undefined {
  let cursor = start_offset;
  let result: Record<string, string> | undefined;

  while (cursor < end_offset) {
    while (cursor < end_offset) {
      const code = source.charCodeAt(cursor);
      if (code !== CC_SPACE && code !== CC_TAB && code !== CC_LF && code !== CC_CR) break;
      cursor++;
    }
    if (cursor >= end_offset) break;
    if (!isAttrNameChar(source.charCodeAt(cursor))) {
      cursor++;
      continue;
    }

    const name_start = cursor;
    cursor++;
    while (cursor < end_offset && isAttrNameChar(source.charCodeAt(cursor))) cursor++;
    const name = source.slice(name_start, cursor);

    while (cursor < end_offset) {
      const code = source.charCodeAt(cursor);
      if (code !== CC_SPACE && code !== CC_TAB && code !== CC_LF && code !== CC_CR) break;
      cursor++;
    }

    let value = '';
    if (cursor < end_offset && source.charCodeAt(cursor) === CC_EQUALS) {
      cursor++;
      while (cursor < end_offset) {
        const code = source.charCodeAt(cursor);
        if (code !== CC_SPACE && code !== CC_TAB && code !== CC_LF && code !== CC_CR) break;
        cursor++;
      }

      if (cursor < end_offset) {
        const quote = source.charCodeAt(cursor);
        if (quote === CC_DOUBLE_QUOTE || quote === CC_SINGLE_QUOTE) {
          cursor++;
          const value_start = cursor;
          while (cursor < end_offset && source.charCodeAt(cursor) !== quote) cursor++;
          value = source.slice(value_start, cursor);
          if (cursor < end_offset) cursor++;
        } else {
          const value_start = cursor;
          while (cursor < end_offset) {
            const code = source.charCodeAt(cursor);
            if (code === CC_SPACE || code === CC_TAB || code === CC_LF || code === CC_CR) break;
            cursor++;
          }
          value = source.slice(value_start, cursor);
        }
      }
    }

    result = result ?? {};
    result[name] = value;
  }

  return result;
}

function referenceProps(
  attributes?: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  if (attributes === undefined) return {};
  const props: Record<string, unknown> = {};
  if (attributes.name !== undefined) props.name = attributes.name;
  if (attributes.group !== undefined) props.group = attributes.group;
  return props;
}

function hasLiteral(
  source: TextSource,
  offset: number,
  end_offset: number,
  literal: string,
): boolean {
  if (offset + literal.length > end_offset) return false;
  for (let index = 0; index < literal.length; index++) {
    if (source.charCodeAt(offset + index) !== literal.charCodeAt(index)) return false;
  }
  return true;
}

function indexOfLiteral(
  source: TextSource,
  literal: string,
  start_offset: number,
  end_offset: number,
): number {
  for (let cursor = start_offset; cursor + literal.length <= end_offset; cursor++) {
    if (hasLiteral(source, cursor, end_offset, literal)) return cursor;
  }
  return -1;
}

function indexOfChar(
  source: TextSource,
  code: number,
  start_offset: number,
  end_offset: number,
): number {
  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    if (source.charCodeAt(cursor) === code) return cursor;
  }
  return -1;
}

function repeatedCharRun(
  source: TextSource,
  offset: number,
  end_offset: number,
  code: number,
): number {
  let run = 0;
  while (offset + run < end_offset && source.charCodeAt(offset + run) === code) run++;
  return run;
}

function scanUrl(source: TextSource, start_offset: number, end_offset: number): number {
  const is_http = hasLiteral(source, start_offset, end_offset, 'http://');
  const is_https = hasLiteral(source, start_offset, end_offset, 'https://');
  if (!is_http && !is_https) return start_offset;

  let cursor = start_offset + (is_https ? 8 : 7);
  while (cursor < end_offset) {
    const code = source.charCodeAt(cursor);
    if (
      code === CC_SPACE ||
      code === CC_TAB ||
      code === CC_LF ||
      code === CC_CR ||
      code === CC_CLOSE_BRACKET ||
      code === CC_GT ||
      code === CC_DOUBLE_QUOTE ||
      code === CC_SINGLE_QUOTE
    ) {
      break;
    }
    cursor++;
  }

  return cursor;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code);
}

function isHexDigit(code: number): boolean {
  return isAsciiDigit(code) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66);
}

function isTagNameStart(code: number): boolean {
  return isAsciiLetter(code);
}

function isTagNameChar(code: number): boolean {
  return isAsciiAlphanumeric(code) || code === CC_DASH || code === CC_COLON;
}

function isAttrNameChar(code: number): boolean {
  return isAsciiAlphanumeric(code) || code === CC_DASH || code === CC_COLON || code === CC_UNDERSCORE;
}