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
 * Performance matters here. The block parser emits raw text spans without
 * inline meaning attached, so this module first merges adjacent spans before
 * scanning them. The scanner then works in absolute source offsets and uses
 * `charCodeAt()` directly. It only slices strings when a node actually needs a
 * convenience string field such as `target`, `name`, or `value`.
 *
 * A concrete example helps here. Suppose the block parser has already decided
 * that this source belongs to one paragraph line:
 *
 * ```text
 * Hello [[Mars|planet]] world
 * ```
 *
 * It may hand the inline parser one merged text range covering that whole line.
 * The inline parser then walks left to right inside that range, keeping plain
 * text plain until it reaches `[[`, and only then emitting link structure.
 *
 * The high-level flow inside one merged text group looks like this:
 *
 * ```text
 * merged text range: "Hello [[Mars|planet]] world"
 *
 *   plain text   opener         plain text
 *   "Hello "     "[["           " world"
 *       |          |                |
 *       +-- emit text when opener appears
 *                  +-- emit wikilink events for Mars|planet
 *                                   +-- emit trailing text at end
 * ```
 *
 * That matters because most source bytes are still ordinary text. The parser
 * stays fast by treating plain text as the default and only paying extra work
 * when a real opener is present.
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
  DiagnosticCode,
  enterEvent,
  errorEvent,
  exitEvent,
  textEvent,
} from './events.ts';

const CC_LF = 0x0a;
const CC_CR = 0x0d;
const CC_SPACE = 0x20;
const CC_TAB = 0x09;
const CC_BANG = 0x21;
const CC_HASH = 0x23;
const CC_AMP = 0x26;
const CC_PERCENT = 0x25;
const CC_APOSTROPHE = 0x27;
const CC_OPEN_PAREN = 0x28;
const CC_CLOSE_PAREN = 0x29;
const CC_PLUS = 0x2b;
const CC_COMMA = 0x2c;
const CC_DASH = 0x2d;
const CC_PERIOD = 0x2e;
const CC_SLASH = 0x2f;
const CC_COLON = 0x3a;
const CC_SEMICOLON = 0x3b;
const CC_LT = 0x3c;
const CC_EQUALS = 0x3d;
const CC_QUESTION = 0x3f;
const CC_GT = 0x3e;
const CC_AT = 0x40;
const CC_OPEN_BRACKET = 0x5b;
const CC_CLOSE_BRACKET = 0x5d;
const CC_OPEN_BRACE = 0x7b;
const CC_CLOSE_BRACE = 0x7d;
const CC_UNDERSCORE = 0x5f;
const CC_PIPE = 0x7c;
const CC_TILDE = 0x7e;
const CC_DOUBLE_QUOTE = 0x22;
const CC_SINGLE_QUOTE = 0x27;

/**
 * Return whether an ASCII code point can begin one of the inline constructs
 * this parser knows how to match.
 *
 * Keeping the cases in one switch makes the lookup table easier to audit than
 * duplicating a long boolean expression inside `Uint8Array.from(...)`. The
 * table still exists because the hot path wants O(1) membership checks while
 * scanning very large plain-text ranges.
 *
 * Two of the starts are worth calling out because they are less obvious than
 * `[` or `<`:
 * - `:` is here because bare URI detection commits at the scheme separator
 * - `{` is here so templates and triple-brace arguments stay on the fast path
 */
function isInlineSpecialStart(code: number): boolean {
  switch (code) {
    case CC_LT:
    case CC_UNDERSCORE:
    case CC_TILDE:
    case CC_AMP:
    case CC_OPEN_BRACKET:
    case CC_APOSTROPHE:
    case CC_COLON:
    case CC_OPEN_BRACE:
      return true;

    default:
      return false;
  }
}

const INLINE_SPECIAL_START = Uint8Array.from({ length: 128 }, (_, code) =>
  isInlineSpecialStart(code) ? 1 : 0,
);

/**
 * Shared context for scanning one merged text group.
 *
 * The block parser may hand us several adjacent text events that are really one
 * continuous inline region. This context stores the source range, the point
 * where that region began, and enough line-start information to rebuild precise
 * `Position` values on demand without storing a `Point` for every code unit.
 *
 * Example:
 *
 * ```text
 * source:       "Hello\n[[Mars]]"
 * offsets:       01234567890123
 *                0    5 6      13
 *
 * merged group: [0, 14)
 * start_point:  line 1, column 1, offset 0
 * line_starts:  [0, 6]
 * ```
 *
 * With that information, the parser can answer questions like "what point is
 * offset 9?" without storing a full point object for offsets 0 through 14.
 */
interface TextGroupContext {
  /** The original source text backing this inline scan. */
  source: TextSource;
  /** Inclusive start offset of the merged text group. */
  start_offset: number;
  /** Exclusive end offset of the merged text group. */
  end_offset: number;
  /** Source position for `start_offset`, used as the anchor for later points. */
  start_point: Point;
  /** Absolute offsets where each logical line in this text group begins. */
  line_starts: number[];
  /** Whether inline recovery should emit diagnostic events. */
  diagnostics: boolean;
  /**
  * Whether recoverable inline constructs keep the default overlay or collapse
  * back to text.
   *
   * `default` keeps recovered wrapper structure when an opener was real but a
   * closer never arrived. `conservative` keeps the diagnostic but collapses
   * the same region back to plain text.
   */
  recovery: 'default' | 'conservative';
}

/**
 * Internal switches for one inline-enrichment lane.
 *
 * These mirror the public parse lanes so the inline parser does not do extra
 * diagnostic work when the caller only wanted the cheap default tree.
 */
export interface InlineEventOptions {
  /** Whether inline-stage diagnostics are emitted into the event stream. */
  readonly diagnostics?: boolean;
  /** Whether malformed inline regions keep the default tree overlay or collapse back to text. */
  readonly recovery?: 'default' | 'conservative';
}

/**
 * Result of recognizing one inline construct at the current cursor.
 *
 * `end_offset` tells the caller where scanning should resume. `events` contains
 * the full enter/exit/text sequence for the construct that matched.
 */
interface SpecialMatch {
  /** Inclusive start offset of the recognized construct. */
  start_offset?: number;
  /** Exclusive end offset of the recognized construct. */
  end_offset: number;
  /** Events emitted for the recognized inline construct. */
  events: WikitextEvent[];
}

/**
 * Parsed shape of an opening HTML-like tag.
 *
 * This is used for generic tags plus special cases such as `nowiki`, `ref`,
 * and `br`. We keep both the original tag name and a lowercase copy so later
 * matching can stay case-insensitive without reslicing repeatedly.
 */
interface TagOpen {
  /** Discriminant for successful opener recognition. */
  kind: 'parsed';
  /** Tag name exactly as it appeared in source. */
  tag_name: string;
  /** Lowercased tag name used for comparisons. */
  tag_name_lower: string;
  /** Exclusive end offset of the parsed opening tag. */
  end_offset: number;
  /** Whether the opening tag ended with `/>`. */
  self_closing: boolean;
  /** Parsed attributes when the tag carried any. */
  attributes?: Readonly<Record<string, string>>;
}

/**
 * A plausible tag opener that never reached its closing `>`.
 *
 * This is the boundary between "the source definitely opened a tag" and
 * "the source only looked like it might start one". The inline parser uses
 * this shape to preserve the original bytes as text while still reporting a
 * recovery diagnostic.
 */
interface UnterminatedTagOpen {
  /** Discriminant for opener recovery before any tag node is committed. */
  kind: 'unterminated';
  /** Tag name exactly as it appeared before EOF or range end. */
  tag_name: string;
  /** Lowercased tag name used for diagnostics. */
  tag_name_lower: string;
}

/** Parsed shape of a closing HTML-like tag such as `</span>`. */
interface TagClose {
  /** Lowercased tag name used for close/open matching. */
  tag_name_lower: string;
  /** Exclusive end offset of the parsed closing tag. */
  end_offset: number;
}

/**
 * Range of the matching close tag for a non-self-closing HTML-like node.
 */
interface TagBoundary {
  /** Inclusive start offset of the closing tag. */
  start_offset: number;
  /** Exclusive end offset of the closing tag. */
  end_offset: number;
}

/**
 * Enrich block-parser text spans with inline markup events.
 *
 * Consecutive text events are merged before scanning because callers may still
 * hand this stage smaller neighboring spans, and inline constructs can cross
 * those boundaries. Parsing each span in isolation would miss multi-span
 * constructs such as `[[link|text]]` and `{{template}}`.
 */
export function* inlineEvents(
  source: TextSource,
  events: Iterable<WikitextEvent>,
  options: InlineEventOptions = {},
): Generator<WikitextEvent> {
  let pending_text: TextEvent[] = [];

  for (const event of events) {
    if (event.kind === 'text') {
      // Today, one text group is only allowed to grow across contiguous source
      // slices. Paragraph continuation lines therefore arrive as separate
      // groups because the newline between them is structural and omitted from
      // the text stream. A future discontiguous handoff experiment would change
      // this exact check: it would keep the paragraph lines together in one
      // logical group without pretending the omitted newline is plain text.
      if (
        pending_text.length > 0 &&
        pending_text[pending_text.length - 1].end_offset !== event.start_offset
      ) {
        yield* parseTextGroup(source, pending_text, options);
        pending_text = [];
      }

      pending_text.push(event);
      continue;
    }

    if (pending_text.length > 0) {
      yield* parseTextGroup(source, pending_text, options);
      pending_text = [];
    }

    yield event;
  }

  if (pending_text.length > 0) {
    yield* parseTextGroup(source, pending_text, options);
  }
}

/**
 * Parse one merged run of adjacent block-parser text events.
 *
 * The block parser may emit several neighboring text events for one logical
 * inline region. Inline constructs can span across those boundaries, so we
 * first merge the run into one scan range and only then resolve inline syntax.
 *
 * Concrete example:
 *
 * ```text
 * block stage hands us:
 *   text("Hello ")
 *   text("[[Mars|planet]]")
 *   text(" world")
 *
 * inline stage treats that as one scan range:
 *   "Hello [[Mars|planet]] world"
 * ```
 *
 * That merge step matters because the link syntax crosses the smaller text
 * event boundaries. Scanning each piece in isolation would miss the full
 * `[[Mars|planet]]` construct.
 */
function* parseTextGroup(
  source: TextSource,
  events: TextEvent[],
  options: InlineEventOptions,
): Generator<WikitextEvent> {
  const first = events[0];
  const last = events[events.length - 1];

  // Most merged text groups are still ordinary prose. When there is no inline
  // opener anywhere in the group, preserve the merged text as-is and skip the
  // extra work of building line-start tables and rescanning the whole range.
  //
  // Example safe fast path:
  //
  //   input range: "Just plain text here"
  //   opener scan: finds no [[, {{, '', <, &, __, ~~~, or bare-url start
  //   result: emit one plain text event and stop
  //
  // This is safe because the block parser has already decided the exact source
  // range for the text group. If there is no possible inline opener inside
  // that range, the inline stage would only rebuild the same text event with
  // newly computed positions.
  if (
    findNextInlineSpecialStart(source, first.start_offset, last.end_offset) ===
    last.end_offset
  ) {
    yield textEvent(first.start_offset, last.end_offset, {
      start: first.position.start,
      end: last.position.end,
    });
    return;
  }

  const ctx = buildTextGroupContext(
    source,
    first.start_offset,
    last.end_offset,
    first.position.start,
  );
  ctx.diagnostics = options.diagnostics === true;
  ctx.recovery = options.recovery ?? 'default';

  yield* parseInlineRange(ctx, ctx.start_offset, ctx.end_offset, true);
}

/**
 * Parse one merged inline text range from left to right.
 *
 * The key invariant here is that `plain_start` always marks the beginning of
 * the next still-unemitted plain-text run. When a matcher recognizes a real
 * inline construct, the parser first flushes the plain text before it, then
 * emits the construct events, then resumes scanning after the construct.
 */

/**
 * Parse one absolute source range.
 *
 * Plain text is emitted lazily only when a special construct is found or the
 * range ends.
 *
 * Read this as a left-to-right scan with deferred text emission. The parser
 * does not emit `text("H")`, `text("He")`, `text("Hel")`, and so on while it
 * walks plain prose. It remembers where the current plain run started, keeps
 * scanning, and only emits that plain range when it must split around real
 * inline syntax.
 *
 * ```text
 * source: "Hello [[Mars]] world"
 *
 * plain_start = 0
 * cursor scans forward until it reaches the `[[` at offset 6
 *
 * flush text [0, 6)      -> "Hello "
 * emit wikilink events   -> "[[Mars]]"
 * resume at offset 14
 *
 * after loop flush trailing text [14, end) -> " world"
 * ```
 *
 * This shape keeps ordinary text cheap. We do not allocate a text event for
 * every character. We hold one pending plain range and only emit it when we
 * have to split around a recognized construct.
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
    // Most bytes inside a merged text group are still ordinary text. Jumping
    // directly to the next possible opener avoids paying `matchSpecial()` on
    // every character of long prose-heavy runs.
    //
    // Example:
    //   "The red planet is [[Mars]]."
    //    ^^^^^^^^^^^^^^^^^^^ jump over this plain prose in one cheap scan
    //                        ^ stop here because `[` could begin inline syntax
    cursor = findNextInlineSpecialStart(ctx.source, cursor, end_offset);
    if (cursor >= end_offset) break;

    const match = matchSpecial(ctx, cursor, end_offset, allow_bare_url, plain_start);
    if (match === null) {
      cursor++;
      continue;
    }

    const match_start = match.start_offset ?? cursor;

    if (plain_start < match_start) {
      yield emitText(ctx, plain_start, match_start);
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

/**
 * Skip forward to the next character that could plausibly open inline syntax.
 */
function findNextInlineSpecialStart(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): number {
  let cursor = start_offset;

  while (cursor < end_offset) {
    const code = source.charCodeAt(cursor);
    if (code < 128 && INLINE_SPECIAL_START[code] === 1) {
      return cursor;
    }
    cursor++;
  }

  return end_offset;
}

/**
 * Try to recognize one inline construct at `cursor`.
 *
 * The order inside each dispatch branch matters. For example, comment syntax
 * must be checked before generic tag parsing because `<!--` also starts with
 * `<`, and triple braces must be checked before double braces because `{{{`
 * would otherwise be consumed as a template opener.
 */
function matchSpecial(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
  allow_bare_url: boolean,
  plain_start: number,
): SpecialMatch | null {
  const code = ctx.source.charCodeAt(cursor);

  // Most characters cannot begin any special construct. Dispatching on the
  // first code point avoids calling every matcher at every cursor, which is
  // especially important on malformed delimiter-heavy input where many matchers
  // would otherwise rescan the same suffix before failing.
  switch (code) {
    case CC_LT:
      return matchComment(ctx, cursor, end_offset) ??
        matchTagLike(ctx, cursor, end_offset);

    case CC_UNDERSCORE:
      return matchBehaviorSwitch(ctx, cursor, end_offset);

    case CC_TILDE:
      return matchSignature(ctx, cursor, end_offset);

    case CC_AMP:
      return matchHtmlEntity(ctx, cursor, end_offset);

    case CC_OPEN_BRACE:
      return matchArgument(ctx, cursor, end_offset) ??
        matchTemplate(ctx, cursor, end_offset);

    case CC_OPEN_BRACKET:
      return matchWikilink(ctx, cursor, end_offset) ??
        matchExternalLink(ctx, cursor, end_offset);

    case CC_COLON:
      return allow_bare_url ? matchBareUrl(ctx, cursor, end_offset, plain_start) : null;

    case CC_APOSTROPHE:
      return matchEmphasis(ctx, cursor, end_offset);

    default:
      return null;
  }
}

/** Match MediaWiki behavior switches such as `__TOC__`. */
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

/** Match signature runs such as `~~~`, `~~~~`, or `~~~~~`. */
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

/** Match one complete HTML entity such as `&amp;` or `&#123;`. */
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

/** Match one complete HTML comment such as `<!--hidden-->`. */
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

/** Match triple-brace argument syntax such as `{{{name|default}}}`. */
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

/**
 * Match template and parser-function syntax.
 *
 * This helper resolves the outer `{{...}}` range first, then finds only the
 * top-level `|` separators so nested templates or wikilinks do not split the
 * outer argument list accidentally.
 */
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
  const first_separator = firstTopLevelSeparator(ctx.source, inner_start, inner_end, CC_PIPE);
  const separators = first_separator === -1
    ? EMPTY_SEPARATOR_LIST
    : [
      first_separator,
      ...topLevelSeparators(ctx.source, first_separator + 1, inner_end, CC_PIPE),
    ];
  const head_end = first_separator === -1 ? inner_end : first_separator;
  const name_range = trimRange(ctx.source, inner_start, head_end);
  const name = ctx.source.slice(name_range.start, name_range.end);
  if (name.length === 0) return null;

  const node_type = name.startsWith('#') ? 'parser-function' : 'template';
  const outer_pos = createPosition(ctx, cursor, close_end);
  const events: WikitextEvent[] = [enterEvent(node_type, { name }, outer_pos)];

  for (let index = 0; index < separators.length; index++) {
    const arg_start = separators[index] + 1;
    const arg_end = index + 1 < separators.length ? separators[index + 1] : inner_end;
    appendTemplateArgument(events, ctx, arg_start, arg_end);
  }

  events.push(exitEvent(node_type, outer_pos));
  return { end_offset: close_end, events };
}

/**
 * Parse one template argument inside an already matched template body.
 *
 * The argument name is structural metadata, so we trim it. The value is parsed
 * as another inline range so nested links, templates, and entities still show
 * up inside argument payloads.
 */
function appendTemplateArgument(
  events: WikitextEvent[],
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
): void {
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

  events.push(enterEvent('template-argument', props, arg_pos));
  appendInlineRange(events, ctx, value_start, end_offset, true);
  events.push(exitEvent('template-argument', arg_pos));
}

/**
 * Match double-bracket link syntax.
 *
 * Namespace dispatch happens here because the same raw `[[...]]` wrapper can
 * mean a normal wikilink, category assignment, or image/file link depending on
 * the trimmed target text.
 */
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
  const first_separator = firstTopLevelSeparator(ctx.source, inner_start, inner_end, CC_PIPE);
  const separators = first_separator === -1
    ? EMPTY_SEPARATOR_LIST
    : [
      first_separator,
      ...topLevelSeparators(ctx.source, first_separator + 1, inner_end, CC_PIPE),
    ];
  const target_end = first_separator === -1 ? inner_end : first_separator;
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
    appendInlineRange(events, ctx, separators[0] + 1, inner_end, false);
  }

  events.push(exitEvent(node_type, outer_pos));
  return { end_offset: close_end, events };
}

/**
 * Match bracketed external-link syntax such as `[https://example.com label]`.
 *
 * The URL must begin immediately after `[` for this form to match. If it does
 * not, later recovery may still find a bare URL inside the brackets.
 */
function matchExternalLink(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (ctx.source.charCodeAt(cursor) !== CC_OPEN_BRACKET || hasLiteral(ctx.source, cursor, end_offset, '[[')) {
    return null;
  }

  const url_end = scanUrl(ctx.source, cursor + 1, end_offset, 'explicit');
  if (url_end === cursor + 1) return null;

  const close = indexOfChar(ctx.source, CC_CLOSE_BRACKET, url_end, end_offset);
  if (close === -1) return null;

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
    appendInlineRange(events, ctx, label_start, close, false);
  }

  events.push(exitEvent('external-link', outer_pos));
  return { end_offset: outer_end, events };
}

/** Match bare URI-like links in plain text once a scheme separator is reached. */
function matchBareUrl(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
  plain_start: number,
): SpecialMatch | null {
  const url_start = findBareUrlStart(ctx.source, cursor, plain_start);
  if (url_start === -1 || !isBareUrlStartBoundary(ctx.source, url_start)) {
    return null;
  }

  const url_end = scanUrl(ctx.source, url_start, end_offset, 'bare');
  if (url_end === url_start) return null;
  const url = ctx.source.slice(url_start, url_end);
  const pos = createPosition(ctx, url_start, url_end);
  return {
    start_offset: url_start,
    end_offset: url_end,
    events: [
      enterEvent('external-link', { url }, pos),
      exitEvent('external-link', pos),
    ],
  };
}

/**
 * Match apostrophe-based emphasis runs.
 *
 * Four apostrophes are the awkward case. MediaWiki-style recovery typically
 * treats that as one literal apostrophe plus a bold run, so we do the same by
 * emitting the first apostrophe as text and then matching bold from the next
 * character.
 */
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

/**
 * Parse the contents of one delimited emphasis range.
 *
 * Emphasis never crosses a physical line break in this implementation. If no
 * closing marker is found before the line ends, recovery closes the node at the
 * line boundary instead of scanning the whole remaining text group.
 */
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
  return {
    end_offset: close_end,
    events: createWrappedInlineEvents(
      ctx,
      cursor,
      close_end,
      node_type,
      {},
      content_start,
      content_end,
      true,
    ),
  };
}

/**
 * Match HTML-like tags and the special inline tags built on that syntax.
 *
 * `br`, `nowiki`, and `ref` get custom node types because downstream consumers
 * are likely to care about them directly. Other tags are normalized into the
 * generic `html-tag` node with preserved attributes.
 */
function matchTagLike(
  ctx: TextGroupContext,
  cursor: number,
  end_offset: number,
): SpecialMatch | null {
  if (ctx.source.charCodeAt(cursor) !== CC_LT) return null;
  if (hasLiteral(ctx.source, cursor, end_offset, '<!--')) return null;

  const tag = parseTagOpen(ctx.source, cursor, end_offset);
  if (tag === null) return null;
  if (tag.kind === 'unterminated') {
    return {
      end_offset,
      events: preserveUnterminatedTagOpenerAsText(ctx, cursor, end_offset, tag.tag_name),
    };
  }

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
    if (close === null) {
      return {
        end_offset,
        events: ctx.recovery === 'conservative'
          ? preserveMissingCloseTagAsText(ctx, cursor, end_offset, tag.tag_name)
          : wrapRecoveredLeaf(
            ctx,
            cursor,
            end_offset,
            'nowiki',
            { value: ctx.source.slice(tag.end_offset, end_offset) },
            tag.tag_name,
          ),
      };
    }
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
    if (close === null) {
      return {
        end_offset,
        events: ctx.recovery === 'conservative'
          ? preserveMissingCloseTagAsText(ctx, cursor, end_offset, tag.tag_name)
          : createRecoveredWrappedInlineEvents(
            ctx,
            cursor,
            end_offset,
            'reference',
            ref_props,
            tag.end_offset,
            end_offset,
            true,
            tag.tag_name,
          ),
      };
    }
    return {
      end_offset: close.end_offset,
      events: createWrappedInlineEvents(
        ctx,
        cursor,
        close.end_offset,
        'reference',
        ref_props,
        tag.end_offset,
        close.start_offset,
        true,
      ),
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
  if (close === null) {
    return {
      end_offset,
      events: ctx.recovery === 'conservative'
        ? preserveMissingCloseTagAsText(ctx, cursor, end_offset, tag.tag_name)
        : createRecoveredWrappedInlineEvents(
          ctx,
          cursor,
          end_offset,
          'html-tag',
          html_props,
          tag.end_offset,
          end_offset,
          true,
          tag.tag_name,
        ),
    };
  }
  return {
    end_offset: close.end_offset,
    events: createWrappedInlineEvents(
      ctx,
      cursor,
      close.end_offset,
      'html-tag',
      html_props,
      tag.end_offset,
      close.start_offset,
      true,
    ),
  };
}

/**
 * Record only line-start offsets for a text group.
 *
 * A `Point` per code unit would be easy to use but too expensive for a hot
 * parser path. Integer line starts are enough to reconstruct positions on
 * demand.
 *
 * Concrete example:
 *
 * ```text
 * source: "A\nBC\nDEF"
 * offsets: 0 1 2 3 4 5 6 7
 *
 * line starts are:
 *   [0, 2, 5]
 *
 * meaning:
 *   line 1 starts at offset 0
 *   line 2 starts at offset 2
 *   line 3 starts at offset 5
 * ```
 *
 * Later, if we need the point for offset 6, we only need to find the most
 * recent line start at or before 6. That is enough to recover line 3,
 * column 2, offset 6.
 *
 * The important boundary here is that this table is local to one merged text
 * group, not the whole document. That keeps the setup cost proportional to the
 * exact range the inline parser is about to scan.
 */
function buildTextGroupContext(
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

  return {
    source,
    start_offset,
    end_offset,
    start_point,
    line_starts,
    diagnostics: true,
    recovery: 'default',
  };
}

const EMPTY_SEPARATOR_LIST: readonly number[] = [];

/**
 * Emit one plain-text event for the given absolute source range.
 *
 * This helper is small, but it exists for one reason: plain text emission in
 * this file is deliberately deferred. Several matchers keep scanning until they
 * know exactly where a plain run ends, then call this helper once with the
 * final range.
 *
 * Example:
 *
 * ```text
 * source: "Hello [[Mars]] world"
 *
 * emitText(..., 0, 6)   -> "Hello "
 * emitText(..., 14, 20) -> " world"
 * ```
 */
function emitText(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
): WikitextEvent {
  return textEvent(start_offset, end_offset, createPosition(ctx, start_offset, end_offset));
}

/**
 * Wrap a leaf-like inline node in matching enter and exit events.
 *
 * This keeps simple constructs such as entities, comments, and self-closing
 * tags consistent with the rest of the event stream without forcing each match
 * helper to rebuild the same enter/exit boilerplate.
 */
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

/**
 * Append a nested inline parse directly into an existing event array.
 *
 * This is the shared "parse children here" helper for templates, links,
 * references, and emphasis. Keeping the append shape explicit avoids building
 * temporary arrays only to spread them immediately into a parent event list.
 */
function appendInlineRange(
  events: WikitextEvent[],
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  allow_bare_url: boolean,
): void {
  for (const event of parseInlineRange(ctx, start_offset, end_offset, allow_bare_url)) {
    events.push(event);
  }
}

/** Create a wrapped inline node without extra temporary arrays from nested spreads. */
function createWrappedInlineEvents(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  node_type: string,
  props: Readonly<Record<string, unknown>>,
  content_start: number,
  content_end: number,
  allow_bare_url: boolean,
): WikitextEvent[] {
  const position = createPosition(ctx, start_offset, end_offset);
  const events: WikitextEvent[] = [enterEvent(node_type, props, position)];
  appendInlineRange(events, ctx, content_start, content_end, allow_bare_url);
  events.push(exitEvent(node_type, position));
  return events;
}

/**
 * Create a wrapped inline node that recovers to the end of the current text range.
 *
 * The opener already reached `>`, so the node is structurally real even though
 * the matching close tag never arrived before the enclosing text group ended.
 */
function createRecoveredWrappedInlineEvents(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  node_type: string,
  props: Readonly<Record<string, unknown>>,
  content_start: number,
  content_end: number,
  allow_bare_url: boolean,
  tag_name: string,
): WikitextEvent[] {
  const events = createWrappedInlineEvents(
    ctx,
    start_offset,
    end_offset,
    node_type,
    props,
    content_start,
    content_end,
    allow_bare_url,
  );
  if (ctx.diagnostics) {
    events.splice(events.length - 1, 0, missingCloseTagError(ctx, end_offset, tag_name));
  }
  return events;
}

/**
 * Wrap a leaf node that had a complete opener but no matching close tag.
 */
function wrapRecoveredLeaf(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  node_type: string,
  props: Readonly<Record<string, unknown>>,
  tag_name: string,
): WikitextEvent[] {
  const position = createPosition(ctx, start_offset, end_offset);
  const events: WikitextEvent[] = [enterEvent(node_type, props, position)];
  if (ctx.diagnostics) {
    events.push(missingCloseTagError(ctx, end_offset, tag_name));
  }
  events.push(exitEvent(node_type, position));
  return events;
}

/**
 * Preserve an unterminated opener as plain text while still reporting recovery.
 */
function preserveUnterminatedTagOpenerAsText(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  tag_name: string,
): WikitextEvent[] {
  const events: WikitextEvent[] = [];
  if (ctx.diagnostics) {
    events.push(unterminatedTagOpenerError(ctx, end_offset, tag_name));
  }
  events.push(emitText(ctx, start_offset, end_offset));
  return events;
}

function preserveMissingCloseTagAsText(
  ctx: TextGroupContext,
  start_offset: number,
  end_offset: number,
  tag_name: string,
): WikitextEvent[] {
  const events: WikitextEvent[] = [];
  if (ctx.diagnostics) {
    events.push(missingCloseTagError(ctx, end_offset, tag_name));
  }
  events.push(emitText(ctx, start_offset, end_offset));
  return events;
}

/**
 * Create a full `Position` object for one absolute source range.
 *
 * This is the point where the inline parser pays the position-construction
 * cost. Upstream code carries offsets and a compact line-start table for as
 * long as possible, then this helper materializes the nested `{ start, end }`
 * shape only when an event is about to be emitted.
 */
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

/**
 * Reconstruct one source point from a text-group-local line-start table.
 *
 * This is a compromise between precision and allocation cost. We pay for a
 * binary search into line starts when we need a point, instead of storing a
 * full point table for every offset in the group.
 *
 * Example using line starts `[0, 6]` from the text `Hello\nMars`:
 *
 * ```text
 * offset 2  -> line 1, column 3
 * offset 8  -> line 2, column 3
 * ```
 *
 * The first case stays on the original `start_point` line. The second case
 * lands after the second recorded line start, so the line number increases and
 * the column resets relative to that later boundary.
 */
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

/**
 * Find the last recorded line start at or before `offset`.
 *
 * This is a binary search over the local `line_starts` table from
 * {@linkcode createTextGroupContext}. The returned index answers one concrete
 * question: which logical line of this text group owns the requested offset?
 *
 * Example with `line_starts = [0, 6, 11]`:
 *
 * ```text
 * offset 2  -> index 0  (first line)
 * offset 6  -> index 1  (second line starts here)
 * offset 10 -> index 1  (still second line)
 * offset 12 -> index 2  (third line)
 * ```
 */
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

/**
 * Find the close boundary for a balanced opener/closer pair.
 *
 * The returned offset is the exclusive end of the closing delimiter. `-1`
 * means the construct never closed cleanly inside the requested range.
 *
 * This helper handles nested forms of the same container kind. For example,
 * the outer `{{...}}` in `{{A|x={{B}}}}` must not close at the inner `}}`.
 *
 * Read the depth rule like this:
 *
 * ```text
 * see opener -> depth + 1
 * see closer -> depth - 1
 * return when depth returns to 0
 * ```
 *
 * The helper is intentionally narrow. It only balances one opener/closer pair
 * family at a time, which keeps it predictable on the hot recovery path.
 */
function findBalanced(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  open: string,
  close: string,
): number {
  // This helper is on the hot recovery path for templates, arguments, and
  // wikilinks. The cheap first-character checks matter because most cursor
  // positions are not actually the start of `open` or `close`, and calling
  // hasLiteral() at every byte made malformed inputs much more expensive.
  const open_first = open.charCodeAt(0);
  const close_first = close.charCodeAt(0);
  let depth = 0;
  let cursor = start_offset;

  while (cursor < end_offset) {
    const code = source.charCodeAt(cursor);

    if (code === open_first && hasLiteral(source, cursor, end_offset, open)) {
      depth++;
      cursor += open.length;
      continue;
    }

    if (code === close_first && hasLiteral(source, cursor, end_offset, close)) {
      depth--;
      cursor += close.length;
      if (depth === 0) return cursor;
      continue;
    }
    cursor++;
  }

  return -1;
}

/**
 * Collect every separator that appears at the current nesting level.
 *
 * Example: in `{{A|x={{B|y}}|z}}`, the outer template has two top-level `|`
 * separators even though there is another `|` inside the nested `{{B|y}}`.
 *
 * The three depth counters model the nested container families that matter for
 * argument splitting here:
 *
 * - `[[...]]`
 * - `{{...}}`
 * - `{{{...}}}`
 *
 * A separator only counts when all three depths are zero. That is what
 * "top-level" means in this file.
 */
function topLevelSeparators(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  separator: number,
): number[] {
  // We only want separators that live at the current nesting level. For
  // example, the `|` inside `{{T|x}}` must not split the surrounding template
  // or wikilink. The depth counters track the three nested inline containers we
  // currently understand well enough to treat as opaque while scanning.
  const result: number[] = [];
  let depth_square = 0;
  let depth_template = 0;
  let depth_argument = 0;

  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    const code = source.charCodeAt(cursor);

    if (code === CC_OPEN_BRACE && hasLiteral(source, cursor, end_offset, '{{{')) {
      depth_argument++;
      cursor += 2;
      continue;
    }

    if (code === CC_CLOSE_BRACE && hasLiteral(source, cursor, end_offset, '}}}')) {
      if (depth_argument > 0) depth_argument--;
      cursor += 2;
      continue;
    }

    if (code === CC_OPEN_BRACE && hasLiteral(source, cursor, end_offset, '{{')) {
      depth_template++;
      cursor += 1;
      continue;
    }

    if (code === CC_CLOSE_BRACE && hasLiteral(source, cursor, end_offset, '}}')) {
      if (depth_template > 0) depth_template--;
      cursor += 1;
      continue;
    }

    if (code === CC_OPEN_BRACKET && hasLiteral(source, cursor, end_offset, '[[')) {
      depth_square++;
      cursor += 1;
      continue;
    }

    if (code === CC_CLOSE_BRACKET && hasLiteral(source, cursor, end_offset, ']]')) {
      if (depth_square > 0) depth_square--;
      cursor += 1;
      continue;
    }

    if (
      code === separator &&
      depth_square === 0 &&
      depth_template === 0 &&
      depth_argument === 0
    ) {
      result.push(cursor);
    }
  }

  return result;
}

/**
 * Find only the first top-level separator without allocating an array.
 *
 * This exists because many call sites only need a yes-or-no split point for
 * the head of a construct, such as the first `|` in a template name/body pair.
 * In those cases, allocating the full separator list would be wasted work.
 */
function firstTopLevelSeparator(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  separator: number,
): number {
  // Many callers only need the first separator. Keeping a dedicated fast path
  // avoids allocating and filling an array that would be thrown away
  // immediately. This matters for the common `name|value` shape inside inline
  // constructs.
  let depth_square = 0;
  let depth_template = 0;
  let depth_argument = 0;

  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    const code = source.charCodeAt(cursor);

    if (code === CC_OPEN_BRACE && hasLiteral(source, cursor, end_offset, '{{{')) {
      depth_argument++;
      cursor += 2;
      continue;
    }

    if (code === CC_CLOSE_BRACE && hasLiteral(source, cursor, end_offset, '}}}')) {
      if (depth_argument > 0) depth_argument--;
      cursor += 2;
      continue;
    }

    if (code === CC_OPEN_BRACE && hasLiteral(source, cursor, end_offset, '{{')) {
      depth_template++;
      cursor += 1;
      continue;
    }

    if (code === CC_CLOSE_BRACE && hasLiteral(source, cursor, end_offset, '}}')) {
      if (depth_template > 0) depth_template--;
      cursor += 1;
      continue;
    }

    if (code === CC_OPEN_BRACKET && hasLiteral(source, cursor, end_offset, '[[')) {
      depth_square++;
      cursor += 1;
      continue;
    }

    if (code === CC_CLOSE_BRACKET && hasLiteral(source, cursor, end_offset, ']]')) {
      if (depth_square > 0) depth_square--;
      cursor += 1;
      continue;
    }

    if (
      code === separator &&
      depth_square === 0 &&
      depth_template === 0 &&
      depth_argument === 0
    ) {
      return cursor;
    }
  }

  return -1;
}

/**
 * Find the first top-level `=` inside a range, if any.
 *
 * Template arguments use this to distinguish positional and named arguments:
 *
 * ```text
 * value        -> no top-level `=` -> positional argument
 * key=value    -> top-level `=`    -> named argument
 * key={{A=B}}  -> inner `=` ignored because it is nested
 * ```
 */
function topLevelEquals(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): number {
  return firstTopLevelSeparator(source, start_offset, end_offset, CC_EQUALS);
}

/**
 * Trim ASCII space, tab, and line-break padding around a source range.
 *
 * This is used for structural fields such as names and targets, where outer
 * padding is usually not meaningful syntax. It does not rewrite the underlying
 * source. It only returns a narrower view into the same offsets.
 */
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

/**
 * Convert a `{ start, end }` range object into a tuple for `slice()`.
 *
 * This helper is tiny, but it keeps the call sites readable where trimming and
 * slicing are chained together.
 */
function rangeTuple(range: { start: number; end: number }): [number, number] {
  return [range.start, range.end];
}

/** Find the first line ending after `start_offset`, or the range end. */
function findLineEnd(source: TextSource, start_offset: number, end_offset: number): number {
  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    const code = source.charCodeAt(cursor);
    if (code === CC_LF || code === CC_CR) return cursor;
  }
  return end_offset;
}

/**
 * Find the next apostrophe run that is long enough to close an emphasis node.
 */
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

/**
 * Parse one opening HTML-like tag.
 *
 * This helper follows a permissive, HTML-like scanning rule inside the opener.
 * Its job is to keep consuming attribute territory until the opener either
 * reaches `>` or the current text range ends. It does not require attribute
 * syntax to be clean before it will keep scanning.
 *
 * The recognition boundary is still the closing `>` of the opener.
 *
 * ```text
 * <ref name="x">body</ref>   -> recognized tag pair
 * <ref foo<div>>body</ref>    -> recognized opener despite malformed attrs
 * <ref name="x">body         -> opener is real, later recovery handles missing close
 * <ref name="x"              -> opener never closed, preserve as text
 * ```
 *
 * This is a recovery policy for wikitext-like parsing, not a byte-for-byte
 * HTML tokenizer. The important contract is simpler: be forgiving while
 * scanning the opener, but only promote text into tag structure after `>` has
 * actually been seen.
 */
function parseTagOpen(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): TagOpen | UnterminatedTagOpen | null {
  if (source.charCodeAt(start_offset) !== CC_LT) return null;
  let cursor = start_offset + 1;
  if (cursor >= end_offset || !isTagNameStart(source.charCodeAt(cursor))) return null;

  const name_start = cursor;
  cursor++;
  while (cursor < end_offset && isTagNameChar(source.charCodeAt(cursor))) cursor++;
  const name_end = cursor;

  let quote = 0;
  let nested_angle_depth = 0;
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
    if (code === CC_LT) {
      nested_angle_depth++;
      self_closing = false;
      cursor++;
      continue;
    }
    if (code === CC_GT) {
      if (nested_angle_depth > 0) {
        nested_angle_depth--;
        self_closing = false;
        cursor++;
        continue;
      }
      const attr_end = self_closing ? cursor - 1 : cursor;
      const tag_name = source.slice(name_start, name_end);
      const attributes = parseAttributes(source, name_end, attr_end);
      return {
        kind: 'parsed',
        tag_name,
        tag_name_lower: tag_name.toLowerCase(),
        end_offset: cursor + 1,
        self_closing,
        attributes,
      };
    }
    self_closing = nested_angle_depth === 0 && code === CC_SLASH;
    cursor++;
  }

  const tag_name = source.slice(name_start, name_end);
  return {
    kind: 'unterminated',
    tag_name,
    tag_name_lower: tag_name.toLowerCase(),
  };
}

/** Parse one closing HTML-like tag such as `</span>`. */
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

/**
 * Find the matching close tag for a previously parsed opening tag.
 *
 * Nested tags of the same name increase depth. Comments are skipped as opaque
 * regions so fake close tags inside `<!-- ... -->` do not interfere with tag
 * recovery.
 */
function findMatchingCloseTag(
  source: TextSource,
  open_tag: TagOpen,
  start_offset: number,
  end_offset: number,
): TagBoundary | null {
  // Generic tag matching can get expensive on malformed input because the naive
  // approach checks every byte as a possible tag boundary. We skip directly to
  // the next `<` because only that character can begin a relevant open tag,
  // close tag, or comment opener.
  let cursor = start_offset;
  let depth = 0;

  while (cursor < end_offset) {
    while (cursor < end_offset && source.charCodeAt(cursor) !== CC_LT) cursor++;
    if (cursor >= end_offset) break;

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
    if (
      nested_open !== null &&
      nested_open.kind === 'parsed' &&
      nested_open.tag_name_lower === open_tag.tag_name_lower
    ) {
      if (!nested_open.self_closing) depth++;
      cursor = nested_open.end_offset;
      continue;
    }

    cursor++;
  }

  return null;
}

/**
 * Parse loose HTML-style attributes from the raw attribute segment.
 *
 * Attribute parsing here is recovery-oriented. Unknown attribute names are
 * preserved, missing values become empty strings, and malformed fragments are
 * skipped rather than throwing.
 */
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

/** Build a zero-width diagnostic position at one absolute source offset. */
function zeroWidthPosition(ctx: TextGroupContext, offset: number): Position {
  return createPosition(ctx, offset, offset);
}

/** Report that a plausible HTML-like opener never reached its closing `>`. */
function unterminatedTagOpenerError(
  ctx: TextGroupContext,
  offset: number,
  tag_name: string,
): WikitextEvent {
  return errorEvent(
    `Unterminated <${tag_name}> opener before end of inline range.`,
    zeroWidthPosition(ctx, offset),
    {
      severity: 'warning',
      code: DiagnosticCode.INLINE_TAG_UNTERMINATED_OPENER,
      recoverable: true,
      source: 'inline',
      details: { tag_name },
    },
  );
}

/** Report that a parsed opener never found its matching close tag. */
function missingCloseTagError(
  ctx: TextGroupContext,
  offset: number,
  tag_name: string,
): WikitextEvent {
  return errorEvent(
    `Missing closing </${tag_name}> before end of inline range.`,
    zeroWidthPosition(ctx, offset),
    {
      severity: 'warning',
      code: DiagnosticCode.INLINE_TAG_MISSING_CLOSE,
      recoverable: true,
      source: 'inline',
      details: { tag_name },
    },
  );
}

/** Reduce raw tag attributes to the public reference-node props we expose. */
function referenceProps(
  attributes?: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  if (attributes === undefined) return {};
  const props: Record<string, unknown> = {};
  if (attributes.name !== undefined) props.name = attributes.name;
  if (attributes.group !== undefined) props.group = attributes.group;
  return props;
}

/** Check whether `literal` appears exactly at `offset`. */
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

/** Find the next occurrence of a literal string within a source range. */
function indexOfLiteral(
  source: TextSource,
  literal: string,
  start_offset: number,
  end_offset: number,
): number {
  // This is a low-level scan helper used by comment and tag recovery. The fast
  // first-character guard keeps it cheap on long regions that contain very few
  // actual candidates for the requested literal.
  const first = literal.charCodeAt(0);

  for (let cursor = start_offset; cursor + literal.length <= end_offset; cursor++) {
    if (source.charCodeAt(cursor) === first && hasLiteral(source, cursor, end_offset, literal)) {
      return cursor;
    }
  }
  return -1;
}

/** Find the next occurrence of one character code within a source range. */
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

/** Count how many times the same character repeats from `offset`. */
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

/**
 * Scan a bare or bracketed external-link URL prefix.
 *
 * This stays deliberately lightweight. It accepts either a generic
 * `scheme://...` prefix or a small allowlist of colon-only schemes such as
 * `mailto:` and `data:`. The scan then applies simple boundary rules and a
 * trim pass instead of instantiating heavier URL objects in the hot path.
 */
type UrlScanMode = 'bare' | 'explicit';

type UriPrefix = {
  scheme_end: number;
  payload_start: number;
  has_authority: boolean;
};

function scanUrl(
  source: TextSource,
  start_offset: number,
  end_offset: number,
  mode: UrlScanMode,
): number {
  const prefix = scanUriPrefix(source, start_offset, end_offset);
  if (prefix === null) return start_offset;

  const { payload_start } = prefix;

  let cursor = payload_start;
  if (cursor >= end_offset) return start_offset;

  const first_payload_code = source.charCodeAt(cursor);
  if (isUrlStopCode(first_payload_code)) return start_offset;

  let open_paren_count = 0;
  let open_square_count = 0;
  let open_curly_count = 0;

  while (cursor < end_offset) {
    const code = source.charCodeAt(cursor);

    if (code === CC_OPEN_PAREN) {
      open_paren_count++;
      cursor++;
      continue;
    }

    if (code === CC_CLOSE_PAREN) {
      if (open_paren_count === 0) break;
      open_paren_count--;
      cursor++;
      continue;
    }

    if (code === CC_OPEN_BRACKET) {
      open_square_count++;
      cursor++;
      continue;
    }

    if (code === CC_CLOSE_BRACKET) {
      if (open_square_count === 0) break;
      open_square_count--;
      cursor++;
      continue;
    }

    if (code === CC_OPEN_BRACE) {
      open_curly_count++;
      cursor++;
      continue;
    }

    if (code === CC_CLOSE_BRACE) {
      if (open_curly_count === 0) break;
      open_curly_count--;
      cursor++;
      continue;
    }

    if (isUrlStopCode(code)) {
      break;
    }

    cursor++;
  }

  const trimmed = trimBareUrlTrailingPunctuation(source, start_offset, cursor);
  if (mode === 'bare' && !isBareAutolinkCandidate(source, start_offset, prefix, trimmed)) {
    return start_offset;
  }

  return trimmed > payload_start ? trimmed : start_offset;
}

function findBareUrlStart(source: TextSource, colon_offset: number, min_offset: number): number {
  let cursor = colon_offset - 1;

  while (cursor >= min_offset && isUriSchemeChar(source.charCodeAt(cursor))) {
    cursor--;
  }

  const start_offset = cursor + 1;
  const scheme_length = colon_offset - start_offset;
  if (scheme_length < 2) return -1;
  if (start_offset < min_offset || !isAsciiLetter(source.charCodeAt(start_offset))) {
    return -1;
  }

  return start_offset;
}

function scanUriPrefix(source: TextSource, start_offset: number, end_offset: number): UriPrefix | null {
  if (start_offset >= end_offset || !isAsciiLetter(source.charCodeAt(start_offset))) {
    return null;
  }

  let cursor = start_offset + 1;
  while (cursor < end_offset && isUriSchemeChar(source.charCodeAt(cursor))) {
    cursor++;
  }

  if (cursor >= end_offset || source.charCodeAt(cursor) !== CC_COLON) {
    return null;
  }

  const scheme_end = cursor;
  if (scheme_end - start_offset < 2) {
    return null;
  }

  const after_colon = cursor + 1;
  if (after_colon >= end_offset) {
    return null;
  }

  if (
    after_colon + 1 < end_offset &&
    source.charCodeAt(after_colon) === CC_SLASH &&
    source.charCodeAt(after_colon + 1) === CC_SLASH
  ) {
    return {
      scheme_end,
      payload_start: after_colon + 2,
      has_authority: true,
    };
  }

  return {
    scheme_end,
    payload_start: after_colon,
    has_authority: false,
  };
}

function isBareUrlStartBoundary(source: TextSource, offset: number): boolean {
  if (offset <= 0) return true;

  const previous = source.charCodeAt(offset - 1);
  return !isAsciiAlphanumeric(previous) && previous !== CC_UNDERSCORE;
}

function isUrlStopCode(code: number): boolean {
  return code === CC_SPACE ||
    code === CC_TAB ||
    code === CC_LF ||
    code === CC_CR ||
    code === CC_LT ||
    code === CC_GT ||
    code === CC_DOUBLE_QUOTE ||
    code === CC_SINGLE_QUOTE;
}

function isUriSchemeChar(code: number): boolean {
  return isAsciiAlphanumeric(code) || code === CC_PLUS || code === CC_DASH || code === CC_PERIOD;
}

function isBareAutolinkCandidate(
  source: TextSource,
  start_offset: number,
  prefix: UriPrefix,
  end_offset: number,
): boolean {
  if (!isBareAutolinkSchemePlausible(source, start_offset, prefix.scheme_end)) {
    return false;
  }

  if (prefix.has_authority) {
    return true;
  }

  return hasBareOpaqueUriEvidence(source, prefix.payload_start, end_offset);
}

function isBareAutolinkSchemePlausible(source: TextSource, start_offset: number, end_offset: number): boolean {
  let has_separator = false;

  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    const code = source.charCodeAt(cursor);
    if (code === CC_PLUS || code === CC_DASH || code === CC_PERIOD) {
      has_separator = true;
      break;
    }
  }

  if (has_separator) {
    return true;
  }

  return end_offset - start_offset <= 7;
}

function hasBareOpaqueUriEvidence(source: TextSource, start_offset: number, end_offset: number): boolean {
  let saw_strong_signal = false;
  let structural_signal_count = 0;
  let colon_count = 0;
  let saw_digit = false;

  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    const code = source.charCodeAt(cursor);

    if (isAsciiDigit(code)) {
      saw_digit = true;
      continue;
    }

    if (isStrongOpaqueUriSignal(code)) {
      saw_strong_signal = true;
      continue;
    }

    if (code === CC_COLON) {
      colon_count++;
      structural_signal_count++;
      continue;
    }

    if (code === CC_EQUALS || code === CC_SEMICOLON || code === CC_COMMA || code === CC_AMP) {
      structural_signal_count++;
      continue;
    }

    if (code === CC_PLUS && cursor === start_offset && cursor + 1 < end_offset) {
      if (isAsciiDigit(source.charCodeAt(cursor + 1))) {
        return true;
      }
      structural_signal_count++;
    }
  }

  if (saw_strong_signal) {
    return true;
  }

  if (colon_count > 0 && saw_digit) {
    return true;
  }

  return structural_signal_count >= 2;
}

function isStrongOpaqueUriSignal(code: number): boolean {
  return code === CC_AT ||
    code === CC_SLASH ||
    code === CC_HASH ||
    code === CC_QUESTION ||
    code === CC_PERCENT;
}

function trimBareUrlTrailingPunctuation(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): number {
  let cursor = end_offset;

  while (cursor > start_offset) {
    const code = source.charCodeAt(cursor - 1);

    if (
      code === CC_PERIOD ||
      code === CC_COMMA ||
      code === CC_SEMICOLON ||
      code === CC_COLON ||
      code === CC_BANG ||
      code === CC_QUESTION
    ) {
      cursor--;
      continue;
    }

    if (code === CC_CLOSE_PAREN && hasUnmatchedTrailingCloseParen(source, start_offset, cursor)) {
      cursor--;
      continue;
    }

    break;
  }

  return cursor;
}

function hasUnmatchedTrailingCloseParen(
  source: TextSource,
  start_offset: number,
  end_offset: number,
): boolean {
  let open_count = 0;
  let close_count = 0;

  for (let cursor = start_offset; cursor < end_offset; cursor++) {
    const code = source.charCodeAt(cursor);
    if (code === CC_OPEN_PAREN) open_count++;
    if (code === CC_CLOSE_PAREN) close_count++;
  }

  return close_count > open_count;
}

/** Whether a code point is an ASCII letter. */
function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** Whether a code point is an ASCII digit. */
function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** Whether a code point is ASCII alphanumeric. */
function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code);
}

/** Whether a code point is a hexadecimal digit. */
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