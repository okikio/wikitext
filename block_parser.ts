/**
 * Block-level parser that turns a token stream into structural events.
 *
 * The tokenizer only marks raw source pieces such as `==`, `*`, `{|`, and
 * plain text. This file is the next step. It reads those tokens line by line
 * and answers a more useful question: what kind of block does this line begin?
 *
 * In practical terms, this stage decides things like:
 *
 * - does this line start a heading?
 * - is this the start of a bullet list or numbered list?
 * - are we entering a table?
 * - should this text become a paragraph?
 *
 * The output is still an event stream rather than a tree. That keeps it useful
 * for streaming callers and lets later stages, especially the inline parser,
 * enrich the structure without rebuilding everything from scratch.
 *
 * ```
 * TextSource -> tokenize() -> blockEvents() -> [inline parser] -> [consumers]
 * ```
 *
 * The parser is line-oriented. That means the first meaningful token on a line
 * usually decides what kind of block the line belongs to.
 *
 * ```
 * first token on line   result
 * -------------------   -------------------------
 * HEADING_MARKER        heading
 * BULLET                bullet list item
 * HASH                  numbered list item
 * SEMICOLON             definition-list term
 * COLON                 definition-list description or indent
 * TABLE_OPEN            table
 * THEMATIC_BREAK        thematic break
 * PREFORMATTED_MARKER   preformatted block
 * anything else         paragraph
 * ```
 *
 * One important limit to keep in mind is that this file is still only doing
 * block structure. If a heading contains `[[Mars]]` or `'''bold'''`, this
 * stage does not parse those inline details yet. It emits text ranges inside
 * the heading and leaves inline meaning for the later inline parser.
 *
 * Like the rest of the pipeline, this parser never throws. If the input is
 * messy, it emits recovery events when needed and still closes open blocks so
 * the event stream stays usable.
 *
 * @example Parsing a heading followed by a paragraph
 * ```ts
 * import { blockEvents } from './block_parser.ts';
 * import { tokenize } from './tokenizer.ts';
 *
 * const source = '== Title ==\nSome text.';
 * const events = [...blockEvents(source, tokenize(source))];
 * ```
 *
 * @example Parsing nested bullet lines
 * ```ts
 * import { blockEvents } from './block_parser.ts';
 * import { tokenize } from './tokenizer.ts';
 *
 * const source = '* A\n** B';
 * const events = [...blockEvents(source, tokenize(source))];
 * ```
 *
 * @module
 */

import type { TextSource } from './text_source.ts';
import type { Token } from './token.ts';
import type { Position, Point, WikitextEvent } from './events.ts';
import { TokenType } from './token.ts';
import {
  DiagnosticCode,
  enterEvent,
  exitEvent,
  textEvent,
  errorEvent,
} from './events.ts';

/**
 * Optional switches for block-event generation.
 *
 * The block parser always keeps recovering structurally so the event stream
 * stays usable. The only question here is whether this caller also wants the
 * block-owned recovery diagnostics preserved in that stream.
 */
export interface BlockEventOptions {
  /** Whether block-stage diagnostics such as unclosed-table warnings are emitted. */
  readonly diagnostics?: boolean;
}

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

/** Build a source point from the current line, column, and offset. */
function point(line: number, column: number, offset: number): Point {
  return { line, column, offset };
}

/** Build a source range from two points. */
function pos(start: Point, end: Point): Position {
  return { start, end };
}

/** Build an empty range at one point. */
function zeroPos(pt: Point): Position {
  return { start: pt, end: pt };
}

// ---------------------------------------------------------------------------
// Line tracker
// ---------------------------------------------------------------------------
//
// Tokens only store start and end offsets. Event positions also need line and
// column, so this tracker keeps that extra running state as tokens are consumed.

interface LineTracker {
  /** 1-based logical line number for the current token cursor. */
  line: number;
  /** Offset of the start of the current line. */
  line_offset: number;
}

/** Turn an offset into a full source point using the current line-tracking state. */
function pointAt(tracker: LineTracker, offset: number): Point {
  return point(tracker.line, 1 + offset - tracker.line_offset, offset);
}

/** Move line tracking forward after consuming a newline token. */
function advanceLine(tracker: LineTracker, newlineEnd: number): void {
  tracker.line++;
  tracker.line_offset = newlineEnd;
}

// ---------------------------------------------------------------------------
// Token buffer
// ---------------------------------------------------------------------------
//
// The block parser sometimes needs to inspect the current token before it
// decides which block parser to enter. This wrapper keeps the current token and
// line-tracking state together so the parser can peek and consume cleanly.

interface TokenBuffer {
  /** Underlying token iterator from the tokenizer stage. */
  iter: Iterator<Token>;
  /** Current token under the parser cursor, or `null` at the end. */
  current: Token | null;
  /** Tracks line/column from newline tokens. */
  tracker: LineTracker;
  /** Whether this parse lane wants block-stage diagnostics. */
  emit_diagnostics: boolean;
}

/**
 * Create a token buffer whose cursor starts at the first token.
 *
 * This keeps three pieces of state together because block parsing needs all of
 * them at once: the current token, the line tracker used for event positions,
 * and whether this caller asked for block-stage diagnostics.
 */
function createBuffer(tokens: Iterable<Token>, emit_diagnostics: boolean): TokenBuffer {
  const iter = tokens[Symbol.iterator]();
  const first = iter.next();
  return {
    iter,
    current: first.done ? null : first.value,
    tracker: { line: 1, line_offset: 0 },
    emit_diagnostics,
  };
}

/**
 * Consume the current token and move to the next one.
 *
 * Newlines are where line/column state advances, so this helper is the single
 * place that keeps token consumption and source-position tracking in sync.
 */
function advance(buf: TokenBuffer): void {
  if (buf.current && buf.current.type === TokenType.NEWLINE) {
    advanceLine(buf.tracker, buf.current.end);
  }
  const next = buf.iter.next();
  buf.current = next.done ? null : next.value;
}

/** Read the current token without consuming it. */
function peek(buf: TokenBuffer): Token | null {
  return buf.current;
}

/** Return the current token and advance the buffer. */
function consume(buf: TokenBuffer): Token | null {
  const tok = buf.current;
  if (tok) advance(buf);
  return tok;
}

// ---------------------------------------------------------------------------
// List stack management
// ---------------------------------------------------------------------------
//
// Wikitext lists are line-oriented: each line's marker prefix determines
// the nesting level and list type. For example:
//
//   *   → depth 1, bullet
//   **  → depth 2, bullet
//   *#  → depth 1 bullet, depth 2 ordered
//
// The block parser maintains a stack of open list levels. When a new line's
// prefix diverges from the stack, we close excess levels and open new ones.

/** Information about one open list depth. */
interface ListLevel {
  /** 'bullet', 'ordered', 'definition-term', or 'definition-description'. */
  kind: string;
  /** Node type for the wrapping list: 'list' or 'definition-list'. */
  list_type: string;
  /** Whether the list is ordered (only for 'list'). */
  ordered: boolean;
}

const DEFAULT_LIST_LEVEL: ListLevel = {
  kind: 'bullet',
  list_type: 'list',
  ordered: false,
};

/**
 * Fixed marker-to-list metadata map used while parsing list prefixes.
 *
 * This is a small hot mapping, not general control flow. A null-prototype
 * object keeps the vocabulary explicit, avoids inherited keys from the normal
 * object prototype chain, and lets `Object.hasOwn(...)` answer "is this one of
 * our markers?" without consulting names such as `toString` or `constructor`.
 */
const LIST_LEVEL_LOOKUP: Partial<Record<string, ListLevel>> = Object.assign(
  Object.create(null),
  {
    '*': DEFAULT_LIST_LEVEL,
    '#': { kind: 'ordered', list_type: 'list', ordered: true },
    ';': { kind: 'definition-term', list_type: 'definition-list', ordered: false },
    ':': { kind: 'definition-description', list_type: 'definition-list', ordered: false },
  },
);

const LIST_MARKER_CHAR_LOOKUP: Partial<Record<TokenType, string>> = Object.assign(
  Object.create(null),
  {
    [TokenType.BULLET]: '*',
    [TokenType.HASH]: '#',
    [TokenType.SEMICOLON]: ';',
    [TokenType.COLON]: ':',
  },
);

/**
 * One merged text range that still maps exactly back to the original source.
 *
 * The block parser sees many small tokenizer tokens such as whitespace, text,
 * punctuation, and delimiter leftovers. The later inline parser does not care
 * about those original token boundaries. It cares about a simpler question:
 * which exact source bytes belong to this block-level text run?
 *
 * `TextSpan` is the answer to that question. Each span records one contiguous
 * `[start, end)` slice of source that the block parser has decided belongs to
 * the current heading, paragraph line, list item line, table cell, or
 * preformatted line.
 *
 * A concrete example is easier than the earlier placeholder A/B/gap diagram.
 * Suppose the source content we want to keep is the line `alpha beta`, and the
 * tokenizer handed this parser three adjacent content tokens:
 *
 *     [0,5)  = 'alpha'
 *     [5,6)  = ' '
 *     [6,10) = 'beta'
 *
 * Those three tokens become one span because each token starts exactly where
 * the previous token ended:
 *
 *     pending span: [0,10)
 *
 * Now compare that with a case where a structural boundary appears in the
 * middle. If a paragraph continues on the next physical line, the newline is a
 * real block-parser boundary, so we do not merge across it:
 *
 *     source:  alpha beta\nsecond line
 *              012345678901234567890
 *                        ^ newline at offset 10
 *
 *     spans:   [0,10)  and  [11,22)
 *
 * Read that as: merge adjacent content bytes, but stop as soon as a newline,
 * cell separator, or real gap means the bytes no longer belong to one local
 * text run.
 *
 * The important invariant is source fidelity. A span may merge neighboring
 * tokens, but it must never invent bytes, skip bytes that belong to content,
 * or cross a structural boundary such as a newline or an inline cell
 * separator.
 */
interface TextSpan {
  /** Inclusive start offset of a merged text range. */
  start: number;
  /** Exclusive end offset of a merged text range. */
  end: number;
}

/**
 * Record one merged text range without allocating per-call closure state.
 *
 * The earlier perf pass used local `flushSpan()` helpers inside several hot
 * block parsers. Those helpers were small, but they still created one closure
 * per parser invocation. This shared helper keeps the same merge behavior while
 * avoiding that repeated setup work.
 *
 * Correctness rule: this helper only merges contiguous token ranges. It does
 * not trim trailing whitespace. Outside headings, trailing spaces are part of
 * the original source range and must remain visible to downstream consumers.
 *
 * The sentinel values `spanStart = -1` and `spanEnd = -1` mean "there is no
 * pending span right now." Callers build a pending span as they walk tokens,
 * then call `pushTextSpan()` only when they hit one of three events:
 *
 * 1. a real gap in offsets
 * 2. a structural boundary such as newline or cell separator
 * 3. the end of the current block-local collection loop
 */
function pushTextSpan(
  spans: TextSpan[],
  start: number,
  end: number,
): void {
  if (start === -1) return;
  spans.push({ start, end });
}

function markerToLevel(marker: string): ListLevel {
  return Object.hasOwn(LIST_LEVEL_LOOKUP, marker)
    ? LIST_LEVEL_LOOKUP[marker]!
    : DEFAULT_LIST_LEVEL;
}

/**
 * Return whether two marker levels can share the same open list wrapper.
 *
 * Raw marker characters are slightly too specific for this check. `;` and `:`
 * produce different child node types, but they still belong to the same
 * `definition-list` wrapper at a given depth.
 */
function canReuseListLevel(openLevel: ListLevel, nextLevel: ListLevel): boolean {
  if (openLevel.list_type !== nextLevel.list_type) {
    return false;
  }

  if (openLevel.list_type === 'definition-list') {
    return true;
  }

  return openLevel.ordered === nextLevel.ordered;
}

// ---------------------------------------------------------------------------
// Block parser generator
// ---------------------------------------------------------------------------

/**
 * Consume a token stream and yield block-level events.
 *
 * Reads tokens produced by {@linkcode tokenize} and emits enter/exit pairs
 * for headings, paragraphs, lists, definition lists, tables, thematic
 * breaks, and preformatted blocks. Inline content is emitted as raw text
 * events for a downstream inline parser to process.
 *
 * The generator never throws. Malformed or unexpected token sequences
 * produce recovery error events and the parser continues.
 *
 * Current diagnostic scope is intentionally narrow. This stage only reports
 * block-owned recovery facts, such as reaching EOF before a table closed. It
 * does not try to attach tree anchors itself because those depend on later
 * tree materialization.
 *
 * @param source - The text source backing the tokens (for offset resolution).
 * @param tokens - Token iterable, typically from `tokenize(source)`.
 */
export function* blockEvents(
  source: TextSource,
  tokens: Iterable<Token>,
  options: BlockEventOptions = {},
): Generator<WikitextEvent> {
  const buf = createBuffer(tokens, options.diagnostics === true);

  // Wrap the root document in enter/exit.
  const startPt = pointAt(buf.tracker, 0);
  yield enterEvent('root', {}, zeroPos(startPt));

  while (peek(buf) !== null) {
    const tok = peek(buf)!;

    // TODO: snapshot recording point for incremental reparsing.
    // A BlockSnapshot captured here (before dispatch) would record the
    // token buffer position, line tracker state, and open block stack,
    // letting the incremental parser restart from any block boundary.

    // Skip newlines between blocks (blank lines).
    if (tok.type === TokenType.NEWLINE) {
      advance(buf);
      continue;
    }

    // Skip EOF.
    if (tok.type === TokenType.EOF) {
      advance(buf);
      continue;
    }

    // Dispatch on the first token of the line.
    switch (tok.type) {
      case TokenType.HEADING_MARKER:
        yield* parseHeading(buf, source);
        break;

      case TokenType.BULLET:
      case TokenType.HASH:
      case TokenType.SEMICOLON:
      case TokenType.COLON:
        yield* parseList(buf, source);
        break;

      case TokenType.TABLE_OPEN:
        yield* parseTable(buf, source);
        break;

      case TokenType.THEMATIC_BREAK:
        yield* parseThematicBreak(buf);
        break;

      case TokenType.PREFORMATTED_MARKER:
        yield* parsePreformatted(buf, source);
        break;

      default:
        yield* parseParagraph(buf, source);
        break;
    }
  }

  const endPt = pointAt(buf.tracker, source.length);
  yield exitEvent('root', zeroPos(endPt));
}

// ---------------------------------------------------------------------------
// Heading parser
// ---------------------------------------------------------------------------
//
// Wikitext headings: `== Title ==`
// The opening `=` count sets the level (1-6). A closing `=` run on the
// same line is optional. Content between them is inline text.
//
// Strategy: collect all tokens on the line, then trim a trailing close
// marker (HEADING_MARKER_CLOSE or EQUALS) and surrounding whitespace
// from the end. This avoids premature close detection for mid-content
// equals signs like `== a=b ==`.

function* parseHeading(
  buf: TokenBuffer,
  _source: TextSource,
): Generator<WikitextEvent> {
  const marker = consume(buf)!;
  const level = Math.min(6, Math.max(1, marker.end - marker.start)) as
    1 | 2 | 3 | 4 | 5 | 6;

  const startPt = pointAt(buf.tracker, marker.start);

  // Collect all tokens on this line (until NEWLINE or EOF).
  const lineTokens: Token[] = [];

  while (peek(buf) !== null) {
    const t = peek(buf)!;
    if (t.type === TokenType.NEWLINE || t.type === TokenType.EOF) break;
    lineTokens.push(t);
    advance(buf);
  }

  let contentStartIndex = 0;
  let contentEndIndex = lineTokens.length;

  // Trim trailing whitespace.
  while (
    contentEndIndex > contentStartIndex &&
    lineTokens[contentEndIndex - 1].type === TokenType.WHITESPACE
  ) {
    contentEndIndex--;
  }

  // Trim trailing close marker (HEADING_MARKER_CLOSE or EQUALS).
  // This scan is intentionally end-biased so inner text like `a=b` survives as
  // heading content instead of being mistaken for the closing marker.
  let endOffset = marker.end;
  if (
    contentEndIndex > contentStartIndex &&
    (lineTokens[contentEndIndex - 1].type === TokenType.HEADING_MARKER_CLOSE ||
      lineTokens[contentEndIndex - 1].type === TokenType.EQUALS)
  ) {
    const closeTok = lineTokens[contentEndIndex - 1];
    contentEndIndex--;
    endOffset = closeTok.end;
  }

  // Trim whitespace between content and the (now-removed) close marker.
  while (
    contentEndIndex > contentStartIndex &&
    lineTokens[contentEndIndex - 1].type === TokenType.WHITESPACE
  ) {
    contentEndIndex--;
  }

  // Trim leading whitespace after the heading marker.
  while (
    contentStartIndex < contentEndIndex &&
    lineTokens[contentStartIndex].type === TokenType.WHITESPACE
  ) {
    contentStartIndex++;
  }

  // Use endOffset from the last remaining token if we have content.
  if (contentStartIndex < contentEndIndex) {
    endOffset = Math.max(endOffset, lineTokens[contentEndIndex - 1].end);
  }

  const endPt = pointAt(buf.tracker, endOffset);
  const headingPos = pos(startPt, endPt);

  yield enterEvent('heading', { level }, headingPos);

  // The inline parser only cares about source ranges, not original tokenizer
  // token boundaries. Merging contiguous spans here avoids re-merging the same
  // text immediately in the next stage.
  if (contentStartIndex < contentEndIndex) {
    yield* emitTextSpans(buf.tracker, [{
      start: lineTokens[contentStartIndex].start,
      end: lineTokens[contentEndIndex - 1].end,
    }]);
  }

  yield exitEvent('heading', headingPos);
}

// ---------------------------------------------------------------------------
// Paragraph parser
// ---------------------------------------------------------------------------
//
// A paragraph is a sequence of lines that don't start with a block
// delimiter. The paragraph ends at a blank line (two consecutive
// newlines), a block-starting token, or EOF.
//
// The comment that matters here is: a paragraph can span many physical lines,
// but this block parser still splits its text spans at each newline.
//
// Concrete example:
//
//   source:
//     Alpha beta
//     Gamma delta
//
//   paragraph node:
//     one paragraph containing both lines
//
//   emitted text spans:
//     [Alpha beta]   then   [Gamma delta]
//
// Diagram:
//
//   paragraph
//     |
//     +-- line 1 content span
//     +-- newline boundary
//     +-- line 2 content span
//
// Why not merge the whole paragraph into one giant span? The important rule is
// more precise than "paragraphs are line-based".
//
// Today, one `text` event means one contiguous source slice. A continued
// paragraph line break sits between those slices as a real newline byte, and
// this block stage treats that newline as paragraph structure rather than as
// emitted text. So the current handoff is:
//
//   enter(paragraph)
//     text("Alpha beta")
//     text("Gamma delta")
//   exit(paragraph)
//
// not:
//
//   enter(paragraph)
//     text("Alpha beta\nGamma delta")
//   exit(paragraph)
//
// A future discontiguous block-to-inline handoff could keep both line slices in
// one logical group, but that would be a new internal contract. It would no
// longer be the same thing as one ordinary contiguous text span.

/**
 * Lookup table for token types that start a new block and therefore terminate
 * a running paragraph.
 *
 * This is a fixed string vocabulary, so a null-prototype object is a tighter
 * fit than a `Set` for the hot membership check inside paragraph parsing.
 * `Object.create(null)` removes the usual prototype chain, and
 * `Object.hasOwn(...)` keeps the check on the table's own keys instead of
 * inherited names such as `toString`.
 */
const BLOCK_START_TOKEN_LOOKUP: Partial<Record<TokenType, true>> = Object.assign(
  Object.create(null),
  {
    [TokenType.HEADING_MARKER]: true,
    [TokenType.BULLET]: true,
    [TokenType.HASH]: true,
    [TokenType.SEMICOLON]: true,
    [TokenType.COLON]: true,
    [TokenType.TABLE_OPEN]: true,
    [TokenType.TABLE_CLOSE]: true,
    [TokenType.THEMATIC_BREAK]: true,
    [TokenType.PREFORMATTED_MARKER]: true,
  },
);

function* parseParagraph(
  buf: TokenBuffer,
  _source: TextSource,
): Generator<WikitextEvent> {
  const firstTok = peek(buf)!;
  const startPt = pointAt(buf.tracker, firstTok.start);

  const contentSpans: TextSpan[] = [];
  let spanStart = -1;
  let spanEnd = -1;
  let _endOffset = firstTok.start;
  let sawNewline = false;

  // Walkthrough for the three span variables used below:
  //
  //   spanStart = where the current pending span begins
  //   spanEnd   = where the current pending span currently ends
  //   contentSpans = finished spans we already decided to keep
  //
  // Sentinel state:
  //
  //   spanStart = -1
  //   spanEnd   = -1
  //
  // means "we are not currently building a span."
  //
  // Example with concrete offsets:
  //
  //   source line:  alpha beta
  //                 0123456789
  //
  //   tokens seen:  [0,5) 'alpha'
  //                 [5,6) ' '
  //                 [6,10) 'beta'
  //
  //   state change:
  //     start with no pending span
  //     read [0,5)   -> pending becomes [0,5)
  //     read [5,6)   -> still adjacent, extend to [0,6)
  //     read [6,10)  -> still adjacent, extend to [0,10)
  //     end of line  -> flush [0,10) into contentSpans

  while (peek(buf) !== null) {
    const t = peek(buf)!;

    if (t.type === TokenType.EOF) break;

    // A newline followed by a block-start token or another newline
    // (blank line) ends the paragraph.
    if (t.type === TokenType.NEWLINE) {
      if (sawNewline) {
        // Double newline (blank line) — end paragraph.
        break;
      }
      sawNewline = true;
      _endOffset = t.end;
      advance(buf);

      // Check what follows the newline.
      const next = peek(buf);
      if (next === null) break;
      if (next.type === TokenType.EOF) break;
      if (next.type === TokenType.NEWLINE) break;
      if (Object.hasOwn(BLOCK_START_TOKEN_LOOKUP, next.type)) break;

      // Each physical line becomes its own merged text span.
      //
      // Example:
      //   source:  Alpha beta\nGamma
      //   before newline: pending span is [Alpha beta]
      //   newline found:  flush that span, then restart on the next line
      //
      // So the paragraph keeps going, but the current line-local span does not.
      // The reason is not that the next line is outside the paragraph. The
      // reason is that one current span must stay contiguous in source, while
      // the continuation newline remains structural instead of becoming text.
      pushTextSpan(contentSpans, spanStart, spanEnd);
      spanStart = -1;
      spanEnd = -1;

      // The newline is part of the paragraph content (continuation line).
      // We don't emit newline tokens as text — they're structural separators
      // within the paragraph's inline content.
      continue;
    }

    sawNewline = false;
    if (spanStart === -1) {
      spanStart = t.start;
      spanEnd = t.end;
    } else if (t.start === spanEnd) {
      spanEnd = t.end;
    } else {
      pushTextSpan(contentSpans, spanStart, spanEnd);
      spanStart = t.start;
      spanEnd = t.end;
    }

    _endOffset = t.end;
    advance(buf);
  }

  // The loop keeps one pending span in local variables for the common fast
  // path. Flush it once at the end so the caller sees the final line segment
  // even when the paragraph ended because of EOF or a block-start token.
  pushTextSpan(contentSpans, spanStart, spanEnd);

  // Don't emit empty paragraphs.
  if (contentSpans.length === 0) return;

  const endPt = pointAt(buf.tracker, contentSpans[contentSpans.length - 1].end);
  const paraPos = pos(startPt, endPt);

  yield enterEvent('paragraph', {}, paraPos);

  // Inline markup is deliberately left unresolved here. Paragraph parsing owns
  // block boundaries; the later inline stage owns links, templates, emphasis,
  // and other nested inline syntax.
  //
  // Performance rule: emit one text event per contiguous span instead of one
  // per tokenizer token. The inline parser only needs accurate source ranges,
  // so coarser text events avoid redundant merge work in the next stage.
  //
  // That still leaves one event per physical paragraph line today, because the
  // newline between continuation lines is structural rather than emitted text.
  // Crossing that boundary with one logical group would require a different
  // internal handoff shape than plain contiguous `text(start_offset, end_offset)`.
  yield* emitTextSpans(buf.tracker, contentSpans);

  yield exitEvent('paragraph', paraPos);
}

// ---------------------------------------------------------------------------
// List parser
// ---------------------------------------------------------------------------
//
// Wikitext lists are line-oriented. Each list line starts with one or more
// marker characters (*#;:). The number and type of markers determines the
// nesting structure.
//
// Once the marker prefix has been consumed, list item text uses the same span
// model as paragraph text, just on a smaller scope: one physical list line.
// The markers and the optional space after them are structure, not content.
//
// Example:
//   * A       → list(ordered=false) > list-item(marker='*')
//   ** B      → list(ordered=false) > list-item(marker='*') > list(ordered=false) > list-item(marker='**')
//   *# C      → list(ordered=false) > list-item(marker='*') > list(ordered=true) > list-item(marker='*#')
//
// The parser processes all consecutive list lines as one group, managing
// a stack of open list/list-item nodes.

function* parseList(
  buf: TokenBuffer,
  _source: TextSource,
): Generator<WikitextEvent> {
  // The open stack tracks which lists and items are currently open.
  // Each entry is { level: ListLevel, had_item: boolean }.
  const openStack: { level: ListLevel; marker_char: string }[] = [];

  // Think of each list line as a prefix rewrite against the previous line:
  //
  // previous: * *
  // current : * #
  //            │ └─ depth 2 changed kind, so close to depth 1 then reopen
  //            └── depth 1 stayed compatible and remains open

  // Process consecutive list lines.
  while (peek(buf) !== null) {
    const t = peek(buf)!;

    // Only list markers start a list line.
    if (
      t.type !== TokenType.BULLET &&
      t.type !== TokenType.HASH &&
      t.type !== TokenType.SEMICOLON &&
      t.type !== TokenType.COLON
    ) {
      break;
    }

    // Collect marker characters for this line.
    const markers: string[] = [];
    let markersEndOffset = t.start;

    while (peek(buf) !== null) {
      const m = peek(buf)!;
      if (
        m.type !== TokenType.BULLET &&
        m.type !== TokenType.HASH &&
        m.type !== TokenType.SEMICOLON &&
        m.type !== TokenType.COLON
      ) {
        break;
      }
      const char = tokenToMarkerChar(m.type);
      markers.push(char);
      markersEndOffset = m.end;
      advance(buf);
    }

    const depth = markers.length;

    // Close levels deeper than the current line's depth.
    yield* closeLevels(buf, openStack, depth);

    // If any shared depth changes list wrapper meaning, close back to the
    // first incompatible depth and reopen from there. This keeps `;` and `:`
    // inside one definition-list wrapper while still splitting `*` and `#`
    // into different list wrappers.
    const sharedDepth = Math.min(openStack.length, depth);
    for (let i = 0; i < sharedDepth; i++) {
      const nextLevel = markerToLevel(markers[i]);
      if (!canReuseListLevel(openStack[i].level, nextLevel)) {
        yield* closeLevels(buf, openStack, i);
        break;
      }
    }

    // Open new levels or adjust existing levels.
    for (let i = openStack.length; i < depth; i++) {
      const markerChar = markers[i];
      const lvl = markerToLevel(markerChar);
      const lvlPt = pointAt(buf.tracker, markersEndOffset);
      const lvlPos = zeroPos(lvlPt);

      // Open the wrapping list node.
      if (lvl.list_type === 'list') {
        yield enterEvent('list', { ordered: lvl.ordered }, lvlPos);
      } else {
        yield enterEvent('definition-list', {}, lvlPos);
      }

      openStack.push({ level: lvl, marker_char: markerChar });
    }

    // Determine the item node type.
    const lastMarker = markers[markers.length - 1];
    const lastLevel = markerToLevel(lastMarker);
    const fullMarker = markers.join('');

    const itemPt = pointAt(buf.tracker, markersEndOffset);

    // Open the list item.
    if (lastLevel.kind === 'definition-term') {
      yield enterEvent('definition-term', {}, zeroPos(itemPt));
    } else if (lastLevel.kind === 'definition-description') {
      yield enterEvent('definition-description', {}, zeroPos(itemPt));
    } else {
      yield enterEvent('list-item', { marker: fullMarker }, zeroPos(itemPt));
    }

    // Skip whitespace after markers.
    while (peek(buf) !== null && peek(buf)!.type === TokenType.WHITESPACE) {
      advance(buf);
    }

    // Collect inline content until newline or EOF.
    const contentSpans: TextSpan[] = [];
    let spanStart = -1;
    let spanEnd = -1;
    let lineEndOffset = markersEndOffset;

    // This loop is the paragraph span algorithm applied to one list line.
    // The only practical difference is the stop condition: list item content
    // ends at the next newline instead of continuing across later lines.

    while (peek(buf) !== null) {
      const ct = peek(buf)!;
      if (ct.type === TokenType.NEWLINE || ct.type === TokenType.EOF) break;
      if (spanStart === -1) {
        spanStart = ct.start;
        spanEnd = ct.end;
      } else if (ct.start === spanEnd) {
        spanEnd = ct.end;
      } else {
        pushTextSpan(contentSpans, spanStart, spanEnd);
        spanStart = ct.start;
        spanEnd = ct.end;
      }

      lineEndOffset = ct.end;
      advance(buf);
    }

    // List item content follows the same rule as paragraphs: merge contiguous
    // source ranges, but preserve exact source bytes inside those ranges.
    //
    // Concrete example:
    //
    //   source:  * item text here
    //            ^ structural marker
    //              ^^^^^^^^^^^^^^ content span that gets emitted
    //
    // The marker and the space after it help define list structure, so they do
    // not become part of the emitted text span.
    pushTextSpan(contentSpans, spanStart, spanEnd);

    yield* emitTextSpans(buf.tracker, contentSpans);

    const itemEndPt = pointAt(buf.tracker, lineEndOffset);

    // Close the list item.
    if (lastLevel.kind === 'definition-term') {
      yield exitEvent('definition-term', zeroPos(itemEndPt));
    } else if (lastLevel.kind === 'definition-description') {
      yield exitEvent('definition-description', zeroPos(itemEndPt));
    } else {
      yield exitEvent('list-item', zeroPos(itemEndPt));
    }

    // Consume the newline if present.
    if (peek(buf) !== null && peek(buf)!.type === TokenType.NEWLINE) {
      advance(buf);
    }
  }

  // Close all remaining open levels.
  yield* closeLevels(buf, openStack, 0);
}

/** Close list levels from the stack down to `targetDepth`. */
function* closeLevels(
  buf: TokenBuffer,
  stack: { level: ListLevel; marker_char: string }[],
  targetDepth: number,
): Generator<WikitextEvent> {
  while (stack.length > targetDepth) {
    const entry = stack.pop()!;
    // When no more tokens remain, use the tracker's current position
    // (line_offset tracks the last known newline boundary).
    const closePt = peek(buf)
      ? pointAt(buf.tracker, peek(buf)!.start)
      : point(buf.tracker.line, 1, buf.tracker.line_offset);
    const closePos = zeroPos(closePt);

    // Close the wrapping list.
    if (entry.level.list_type === 'list') {
      yield exitEvent('list', closePos);
    } else {
      yield exitEvent('definition-list', closePos);
    }
  }
}

/** Convert a list marker token type back into the source marker character. */
function tokenToMarkerChar(type: TokenType): string {
  return Object.hasOwn(LIST_MARKER_CHAR_LOOKUP, type)
    ? LIST_MARKER_CHAR_LOOKUP[type]!
    : '*';
}

// ---------------------------------------------------------------------------
// Table parser
// ---------------------------------------------------------------------------
//
// Wikitext tables:
//   {| attributes    → table open
//   |+ caption       → table caption
//   |-  attributes   → row separator
//   | cell           → data cell
//   || cell          → inline data cell separator
//   ! cell           → header cell
//   !! cell          → inline header cell separator
//   |}               → table close
//
// Rows are implicit: the first cell after `{|` or `|+` starts an
// implicit row. `|-` explicitly starts a new row.

function* parseTable(
  buf: TokenBuffer,
  source: TextSource,
): Generator<WikitextEvent> {
  const openTok = consume(buf)!; // TABLE_OPEN
  const startPt = pointAt(buf.tracker, openTok.start);

  // Collect attributes after {| on the same line.
  const attrTokens: Token[] = [];
  while (peek(buf) !== null) {
    const t = peek(buf)!;
    if (t.type === TokenType.NEWLINE || t.type === TokenType.EOF) break;
    attrTokens.push(t);
    advance(buf);
  }
  const attributes = attrTokens.length > 0
    ? joinTokenText(source, attrTokens).trim()
    : undefined;

  yield enterEvent('table', attributes !== undefined ? { attributes } : {}, zeroPos(startPt));

  // Consume trailing newline.
  if (peek(buf) !== null && peek(buf)!.type === TokenType.NEWLINE) {
    advance(buf);
  }

  let rowOpen = false;
  let cellOpen = false;

  // Tables are mostly driven one physical line at a time:
  //
  // {|    open table
  // |+    caption
  // |-    explicit row boundary
  // |/!   cell line, with implicit row creation if needed
  // |}    close table
  //
  // `rowOpen` and `cellOpen` let recovery close the right structure when the
  // source omits an expected row separator or table terminator.

  // Process table body line by line until TABLE_CLOSE or EOF.
  while (peek(buf) !== null) {
    const t = peek(buf)!;

    if (t.type === TokenType.EOF) break;

    // Table close: |}
    if (t.type === TokenType.TABLE_CLOSE) {
      if (cellOpen) {
        yield* closeCell(buf);
        cellOpen = false;
      }
      if (rowOpen) {
        yield* closeRow(buf);
        rowOpen = false;
      }
      const closePt = pointAt(buf.tracker, t.end);
      advance(buf);
      yield exitEvent('table', zeroPos(closePt));
      // Consume trailing newline.
      if (peek(buf) !== null && peek(buf)!.type === TokenType.NEWLINE) {
        advance(buf);
      }
      return;
    }

    // Skip blank lines inside table.
    if (t.type === TokenType.NEWLINE) {
      advance(buf);
      continue;
    }

    // Table row separator: |-
    if (t.type === TokenType.TABLE_ROW) {
      if (cellOpen) {
        yield* closeCell(buf);
        cellOpen = false;
      }
      if (rowOpen) {
        yield* closeRow(buf);
        rowOpen = false;
      }
      advance(buf);
      const rowPt = pointAt(buf.tracker, t.start);

      // Row attributes on the same line.
      const rowAttrTokens: Token[] = [];
      while (peek(buf) !== null) {
        const rt = peek(buf)!;
        if (rt.type === TokenType.NEWLINE || rt.type === TokenType.EOF) break;
        rowAttrTokens.push(rt);
        advance(buf);
      }
      const rowAttrs = rowAttrTokens.length > 0
        ? joinTokenText(source, rowAttrTokens).trim()
        : undefined;

      yield enterEvent('table-row',
        rowAttrs !== undefined ? { attributes: rowAttrs } : {},
        zeroPos(rowPt));
      rowOpen = true;

      // Consume newline.
      if (peek(buf) !== null && peek(buf)!.type === TokenType.NEWLINE) {
        advance(buf);
      }
      continue;
    }

    // Table caption: |+
    if (t.type === TokenType.TABLE_CAPTION) {
      if (cellOpen) {
        yield* closeCell(buf);
        cellOpen = false;
      }
      advance(buf);
      const capPt = pointAt(buf.tracker, t.start);

      yield enterEvent('table-caption', {}, zeroPos(capPt));

      // Caption content until newline or EOF.
      yield* emitLineContent(buf);

      const capEndPt = peek(buf)
        ? pointAt(buf.tracker, peek(buf)!.start)
        : pointAt(buf.tracker, source.length);
      yield exitEvent('table-caption', zeroPos(capEndPt));

      // Consume newline.
      if (peek(buf) !== null && peek(buf)!.type === TokenType.NEWLINE) {
        advance(buf);
      }
      continue;
    }

    // Header cell: ! at line start
    if (t.type === TokenType.TABLE_HEADER_CELL) {
      if (cellOpen) {
        yield* closeCell(buf);
        cellOpen = false;
      }
      if (!rowOpen) {
        // The first cell line after `{|` implicitly starts a row even without
        // an explicit `|-` line.
        const rowPt = pointAt(buf.tracker, t.start);
        yield enterEvent('table-row', {}, zeroPos(rowPt));
        rowOpen = true;
      }
      advance(buf);
      yield* parseTableCells(buf, source, true);
      cellOpen = false; // parseTableCells handles open/close
      // Consume newline.
      if (peek(buf) !== null && peek(buf)!.type === TokenType.NEWLINE) {
        advance(buf);
      }
      continue;
    }

    // Data cell: | at line start
    if (t.type === TokenType.PIPE) {
      if (cellOpen) {
        yield* closeCell(buf);
        cellOpen = false;
      }
      if (!rowOpen) {
        const rowPt = pointAt(buf.tracker, t.start);
        yield enterEvent('table-row', {}, zeroPos(rowPt));
        rowOpen = true;
      }
      advance(buf);
      yield* parseTableCells(buf, source, false);
      cellOpen = false;
      // Consume newline.
      if (peek(buf) !== null && peek(buf)!.type === TokenType.NEWLINE) {
        advance(buf);
      }
      continue;
    }

    // Anything else inside the table is recovery territory. Advancing keeps the
    // parser moving so malformed table content does not trap the loop.
    advance(buf);
  }

  // End of input: close any open structures.
  if (cellOpen) {
    yield* closeCell(buf);
  }
  if (rowOpen) {
    yield* closeRow(buf);
  }
  const endPt = pointAt(buf.tracker, source.length);
  if (buf.emit_diagnostics) {
    yield unclosedTableDiagnostic(endPt);
  }
  yield exitEvent('table', zeroPos(endPt));
}

/**
 * Report that the block parser reached end of input before a table closed.
 *
 * This happens when the source opens a table with `{|` but never reaches the
 * matching `|}` before EOF.
 *
 * Example input:
 *
 * ```text
 * {| class="wikitable"
 * | Planet
 * | Mars
 * ```
 *
 * The parser still closes the table in recovery mode so downstream consumers
 * get a usable tree. Consumers can respond in a few different ways depending
 * on their product goals:
 *
 * - show a warning and keep rendering the recovered table
 * - offer a quick fix that inserts a closing `|}`
 * - ignore the warning in best-effort batch processing that only needs a
 *   stable structure
 *
 * None of those responses is mandatory. The parser's contract is only that it
 * records the recovery and still produces valid output.
 */
function unclosedTableDiagnostic(end: Point): WikitextEvent {
  return errorEvent('Unclosed table at end of input', zeroPos(end), {
    severity: 'warning',
    code: DiagnosticCode.UNCLOSED_TABLE,
    recoverable: true,
    source: 'block',
  });
}

/** Parse cells on one line, handling `||` and `!!` inline separators. */
function* parseTableCells(
  buf: TokenBuffer,
  source: TextSource,
  header: boolean,
): Generator<WikitextEvent> {
  // Parse the first cell and any inline-separated cells on this line.
  const separator = header ? TokenType.DOUBLE_BANG : TokenType.DOUBLE_PIPE;

  while (true) {
    const cellPt = peek(buf)
      ? pointAt(buf.tracker, peek(buf)!.start)
      : pointAt(buf.tracker, source.length);

    yield enterEvent('table-cell', { header }, zeroPos(cellPt));

    // Skip leading whitespace.
    while (peek(buf) !== null && peek(buf)!.type === TokenType.WHITESPACE) {
      advance(buf);
    }

    // Collect cell content until separator, newline, or EOF.
    const contentSpans: TextSpan[] = [];
    let spanStart = -1;
    let spanEnd = -1;
    let hitSeparator = false;

    // Table cell spans use the same pending-span state as paragraphs and list
    // items, but with one extra boundary: `||` or `!!` must split cells even
    // when the bytes on both sides are adjacent in the original source.
    //
    // Concrete example:
    //
    //   source:  | A || B
    //              ^^^^ first cell content
    //                  ^^ separator
    //                     ^^ second cell content
    //
    // The separator is structure, not content, so we flush the first cell span
    // before consuming `||` and then start a fresh span for `B`.

    while (peek(buf) !== null) {
      const ct = peek(buf)!;
      if (ct.type === TokenType.NEWLINE || ct.type === TokenType.EOF) break;
      if (ct.type === separator) {
        // Inline separators like `||` and `!!` are real structure boundaries.
        // Flush the current merged span before consuming the separator so the
        // cell content range stays faithful to the original source.
        pushTextSpan(contentSpans, spanStart, spanEnd);
        spanStart = -1;
        spanEnd = -1;
        hitSeparator = true;
        advance(buf);
        break;
      }
      // Also handle `!!` as separator in header context when seeing DOUBLE_BANG
      // even from a data cell start (mixed usage).
      if (header && ct.type === TokenType.DOUBLE_BANG) {
        pushTextSpan(contentSpans, spanStart, spanEnd);
        spanStart = -1;
        spanEnd = -1;
        hitSeparator = true;
        advance(buf);
        break;
      }
      if (spanStart === -1) {
        spanStart = ct.start;
        spanEnd = ct.end;
      } else if (ct.start === spanEnd) {
        spanEnd = ct.end;
      } else {
        pushTextSpan(contentSpans, spanStart, spanEnd);
        spanStart = ct.start;
        spanEnd = ct.end;
      }

      advance(buf);
    }

    pushTextSpan(contentSpans, spanStart, spanEnd);

    yield* emitTextSpans(buf.tracker, contentSpans);

    const cellEndPt = contentSpans.length > 0
      ? pointAt(buf.tracker, contentSpans[contentSpans.length - 1].end)
      : cellPt;
    yield exitEvent('table-cell', zeroPos(cellEndPt));

    // `||` and `!!` mean there is another cell on the same physical line.
    if (!hitSeparator) break;
  }
}

/** Close a table cell at the current cursor position. */
function* closeCell(buf: TokenBuffer): Generator<WikitextEvent> {
  const pt = peek(buf)
    ? pointAt(buf.tracker, peek(buf)!.start)
    : point(buf.tracker.line, 1, buf.tracker.line_offset);
  yield exitEvent('table-cell', zeroPos(pt));
}

/** Close a table row at the current cursor position. */
function* closeRow(buf: TokenBuffer): Generator<WikitextEvent> {
  const pt = peek(buf)
    ? pointAt(buf.tracker, peek(buf)!.start)
    : point(buf.tracker.line, 1, buf.tracker.line_offset);
  yield exitEvent('table-row', zeroPos(pt));
}

/** Emit text events for tokens until newline or EOF. */
function* emitLineContent(
  buf: TokenBuffer,
): Generator<WikitextEvent> {
  const lineSpans: TextSpan[] = [];
  let spanStart = -1;
  let spanEnd = -1;

  while (peek(buf) !== null) {
    const t = peek(buf)!;
    if (t.type === TokenType.NEWLINE || t.type === TokenType.EOF) break;
    // Used for simple single-line payloads such as captions where the block
    // container is already known and only raw text needs to be forwarded.
    if (spanStart === -1) {
      spanStart = t.start;
      spanEnd = t.end;
    } else if (t.start === spanEnd) {
      spanEnd = t.end;
    } else {
      pushTextSpan(lineSpans, spanStart, spanEnd);
      spanStart = t.start;
      spanEnd = t.end;
    }

    advance(buf);
  }

  // Captions and similar single-line payloads do not need token granularity.
  // One merged range is enough unless a real gap appears in the underlying
  // tokens.
  //
  // Example:
  //   |+ caption text
  //      ^^^^^^^^^^^^ one merged line-local span
  //
  // This helper exists so caption handling can reuse the same span model as
  // other block text paths without duplicating the state machine again.
  pushTextSpan(lineSpans, spanStart, spanEnd);
  yield* emitTextSpans(buf.tracker, lineSpans);
}

/**
 * Emit already-merged text spans as text events.
 *
 * The important invariant is simple: these spans must still cover the exact
 * bytes the block parser decided belong to the block. This helper is only an
 * event materialization step. It must not normalize spacing, trim content, or
 * reinterpret structure.
 *
 * Every span passed here is expected to be line-local. That is why one current
 * `LineTracker` state is enough to reconstruct both points for the event.
 * Callers split on newlines earlier, then `emitTextSpans()` converts each
 * finished `[start, end)` range into a proper `text` event.
 *
 * Example:
 *
 *     spans from caller: [12,20) and [24,31)
 *     emitted events:    text(12,20) and text(24,31)
 *
 * This helper does not decide where spans begin or end. It only turns already
 * approved spans into event objects with correct positions.
 */
function* emitTextSpans(
  tracker: LineTracker,
  spans: readonly TextSpan[],
): Generator<WikitextEvent> {
  for (const span of spans) {
    const eventStart = pointAt(tracker, span.start);
    const eventEnd = pointAt(tracker, span.end);
    yield textEvent(span.start, span.end, pos(eventStart, eventEnd));
  }
}

/** Concatenate text of tokens by slicing from the source. */
function joinTokenText(source: TextSource, tokens: Token[]): string {
  if (tokens.length === 0) return '';
  const start = tokens[0].start;
  const end = tokens[tokens.length - 1].end;
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// Thematic break parser
// ---------------------------------------------------------------------------

function* parseThematicBreak(
  buf: TokenBuffer,
): Generator<WikitextEvent> {
  const tok = consume(buf)!;
  const startPt = pointAt(buf.tracker, tok.start);
  const endPt = pointAt(buf.tracker, tok.end);
  const breakPos = pos(startPt, endPt);

  yield enterEvent('thematic-break', {}, breakPos);
  yield exitEvent('thematic-break', breakPos);
}

// ---------------------------------------------------------------------------
// Preformatted block parser
// ---------------------------------------------------------------------------
//
// Lines starting with a space are preformatted (rendered as <pre>).
// Consecutive preformatted lines form one preformatted block.
//
// This is the strictest source-fidelity path in the block parser. After the
// leading structural marker space, the rest of each line is treated as literal
// content. That means the span collector must preserve trailing spaces instead
// of trimming or normalizing them.

function* parsePreformatted(
  buf: TokenBuffer,
  source: TextSource,
): Generator<WikitextEvent> {
  const firstTok = peek(buf)!;
  const startPt = pointAt(buf.tracker, firstTok.start);

  yield enterEvent('preformatted', {}, zeroPos(startPt));

  // Process consecutive preformatted lines.
  while (peek(buf) !== null && peek(buf)!.type === TokenType.PREFORMATTED_MARKER) {
    // Skip the preformatted marker (leading space).
    advance(buf);

    // Emit content of this line.
    const lineSpans: TextSpan[] = [];
    let spanStart = -1;
    let spanEnd = -1;

    // Read this as: skip the one structural marker byte, then preserve every
    // remaining byte on the line exactly as authored.
    //
    // Example:
    //   source:  " pre  text  "
    //             ^ structural marker, not emitted
    //              ^^^^^^^^^^^ literal content, including trailing spaces

    while (peek(buf) !== null) {
      const t = peek(buf)!;
      if (t.type === TokenType.NEWLINE || t.type === TokenType.EOF) break;
      // The leading space is structural and already consumed, so the emitted
      // text starts with the first token after that marker.
      if (spanStart === -1) {
        spanStart = t.start;
        spanEnd = t.end;
      } else if (t.start === spanEnd) {
        spanEnd = t.end;
      } else {
        pushTextSpan(lineSpans, spanStart, spanEnd);
        spanStart = t.start;
        spanEnd = t.end;
      }

      advance(buf);
    }

    // Preformatted content is the strictest source-fidelity case in this file.
    // After the leading marker space, every remaining byte on the line counts
    // as user content, including trailing spaces.
    pushTextSpan(lineSpans, spanStart, spanEnd);
    yield* emitTextSpans(buf.tracker, lineSpans);

    // Consume newline.
    if (peek(buf) !== null && peek(buf)!.type === TokenType.NEWLINE) {
      advance(buf);
    }
  }

  const endPt = peek(buf)
    ? pointAt(buf.tracker, peek(buf)!.start)
    : pointAt(buf.tracker, source.length);
  yield exitEvent('preformatted', zeroPos(endPt));
}
