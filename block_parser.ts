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
  enterEvent,
  exitEvent,
  textEvent,
  errorEvent,
} from './events.ts';

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
  iter: Iterator<Token>;
  current: Token | null;
  /** Tracks line/column from newline tokens. */
  tracker: LineTracker;
}

function createBuffer(tokens: Iterable<Token>): TokenBuffer {
  const iter = tokens[Symbol.iterator]();
  const first = iter.next();
  return {
    iter,
    current: first.done ? null : first.value,
    tracker: { line: 1, line_offset: 0 },
  };
}

/** Consume the current token and move to the next one, updating line tracking on newlines. */
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

function markerToLevel(marker: string): ListLevel {
  switch (marker) {
    case '*': return { kind: 'bullet', list_type: 'list', ordered: false };
    case '#': return { kind: 'ordered', list_type: 'list', ordered: true };
    case ';': return { kind: 'definition-term', list_type: 'definition-list', ordered: false };
    case ':': return { kind: 'definition-description', list_type: 'definition-list', ordered: false };
    default: return { kind: 'bullet', list_type: 'list', ordered: false };
  }
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
 * @param source - The text source backing the tokens (for offset resolution).
 * @param tokens - Token iterable, typically from `tokenize(source)`.
 */
export function* blockEvents(
  source: TextSource,
  tokens: Iterable<Token>,
): Generator<WikitextEvent> {
  const buf = createBuffer(tokens);

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

  // Trim trailing whitespace.
  while (
    lineTokens.length > 0 &&
    lineTokens[lineTokens.length - 1].type === TokenType.WHITESPACE
  ) {
    lineTokens.pop();
  }

  // Trim trailing close marker (HEADING_MARKER_CLOSE or EQUALS).
  let endOffset = marker.end;
  if (
    lineTokens.length > 0 &&
    (lineTokens[lineTokens.length - 1].type === TokenType.HEADING_MARKER_CLOSE ||
      lineTokens[lineTokens.length - 1].type === TokenType.EQUALS)
  ) {
    const closeTok = lineTokens.pop()!;
    endOffset = closeTok.end;
  }

  // Trim whitespace between content and the (now-removed) close marker.
  while (
    lineTokens.length > 0 &&
    lineTokens[lineTokens.length - 1].type === TokenType.WHITESPACE
  ) {
    lineTokens.pop();
  }

  // Trim leading whitespace after the heading marker.
  while (
    lineTokens.length > 0 &&
    lineTokens[0].type === TokenType.WHITESPACE
  ) {
    lineTokens.shift();
  }

  // Use endOffset from the last remaining token if we have content.
  if (lineTokens.length > 0) {
    endOffset = Math.max(endOffset, lineTokens[lineTokens.length - 1].end);
  }

  const endPt = pointAt(buf.tracker, endOffset);
  const headingPos = pos(startPt, endPt);

  yield enterEvent('heading', { level }, headingPos);

  // Emit text events for the content tokens.
  for (const ct of lineTokens) {
    const ctStart = pointAt(buf.tracker, ct.start);
    const ctEnd = pointAt(buf.tracker, ct.end);
    yield textEvent(ct.start, ct.end, pos(ctStart, ctEnd));
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

/** The set of token types that start a new block (terminating a paragraph). */
const BLOCK_START_TOKENS: ReadonlySet<string> = new Set([
  TokenType.HEADING_MARKER,
  TokenType.BULLET,
  TokenType.HASH,
  TokenType.SEMICOLON,
  TokenType.COLON,
  TokenType.TABLE_OPEN,
  TokenType.TABLE_CLOSE,
  TokenType.THEMATIC_BREAK,
  TokenType.PREFORMATTED_MARKER,
]);

function* parseParagraph(
  buf: TokenBuffer,
  _source: TextSource,
): Generator<WikitextEvent> {
  const firstTok = peek(buf)!;
  const startPt = pointAt(buf.tracker, firstTok.start);

  const contentTokens: Token[] = [];
  let _endOffset = firstTok.start;
  let sawNewline = false;

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
      if (BLOCK_START_TOKENS.has(next.type)) break;

      // The newline is part of the paragraph content (continuation line).
      // We don't emit newline tokens as text — they're structural separators
      // within the paragraph's inline content.
      continue;
    }

    sawNewline = false;
    contentTokens.push(t);
    _endOffset = t.end;
    advance(buf);
  }

  // Trim trailing whitespace from content tokens.
  while (
    contentTokens.length > 0 &&
    contentTokens[contentTokens.length - 1].type === TokenType.WHITESPACE
  ) {
    contentTokens.pop();
  }

  // Don't emit empty paragraphs.
  if (contentTokens.length === 0) return;

  const lastTok = contentTokens[contentTokens.length - 1];
  const endPt = pointAt(buf.tracker, lastTok.end);
  const paraPos = pos(startPt, endPt);

  yield enterEvent('paragraph', {}, paraPos);

  for (const ct of contentTokens) {
    const ctStart = pointAt(buf.tracker, ct.start);
    const ctEnd = pointAt(buf.tracker, ct.end);
    yield textEvent(ct.start, ct.end, pos(ctStart, ctEnd));
  }

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

    // If marker type changed at an existing depth, close back to that point
    // and reopen with the new type. Example: `* A\n# B` at depth 1 switches
    // from bullet to ordered.
    if (openStack.length > 0 && openStack.length <= depth) {
      const topIdx = openStack.length - 1;
      if (openStack[topIdx].marker_char !== markers[topIdx]) {
        yield* closeLevels(buf, openStack, topIdx);
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
    const contentTokens: Token[] = [];
    let lineEndOffset = markersEndOffset;

    while (peek(buf) !== null) {
      const ct = peek(buf)!;
      if (ct.type === TokenType.NEWLINE || ct.type === TokenType.EOF) break;
      contentTokens.push(ct);
      lineEndOffset = ct.end;
      advance(buf);
    }

    // Emit text events for line content.
    for (const ct of contentTokens) {
      const ctStart = pointAt(buf.tracker, ct.start);
      const ctEnd = pointAt(buf.tracker, ct.end);
      yield textEvent(ct.start, ct.end, pos(ctStart, ctEnd));
    }

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

function tokenToMarkerChar(type: TokenType): string {
  switch (type) {
    case TokenType.BULLET: return '*';
    case TokenType.HASH: return '#';
    case TokenType.SEMICOLON: return ';';
    case TokenType.COLON: return ':';
    default: return '*';
  }
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

    // Anything else inside the table: treat as continuation content.
    // This handles malformed table content gracefully.
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
  yield errorEvent('Unclosed table at end of input', zeroPos(endPt), {
    severity: 'warning',
    code: 'UNCLOSED_TABLE',
    recoverable: true,
    source: 'block',
  });
  yield exitEvent('table', zeroPos(endPt));
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
    const contentTokens: Token[] = [];
    let hitSeparator = false;

    while (peek(buf) !== null) {
      const ct = peek(buf)!;
      if (ct.type === TokenType.NEWLINE || ct.type === TokenType.EOF) break;
      if (ct.type === separator) {
        hitSeparator = true;
        advance(buf);
        break;
      }
      // Also handle `!!` as separator in header context when seeing DOUBLE_BANG
      // even from a data cell start (mixed usage).
      if (header && ct.type === TokenType.DOUBLE_BANG) {
        hitSeparator = true;
        advance(buf);
        break;
      }
      contentTokens.push(ct);
      advance(buf);
    }

    // Emit text for the cell content.
    for (const ct of contentTokens) {
      const ctStart = pointAt(buf.tracker, ct.start);
      const ctEnd = pointAt(buf.tracker, ct.end);
      yield textEvent(ct.start, ct.end, pos(ctStart, ctEnd));
    }

    const cellEndPt = contentTokens.length > 0
      ? pointAt(buf.tracker, contentTokens[contentTokens.length - 1].end)
      : cellPt;
    yield exitEvent('table-cell', zeroPos(cellEndPt));

    if (!hitSeparator) break;
  }
}

function* closeCell(buf: TokenBuffer): Generator<WikitextEvent> {
  const pt = peek(buf)
    ? pointAt(buf.tracker, peek(buf)!.start)
    : point(buf.tracker.line, 1, buf.tracker.line_offset);
  yield exitEvent('table-cell', zeroPos(pt));
}

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
  while (peek(buf) !== null) {
    const t = peek(buf)!;
    if (t.type === TokenType.NEWLINE || t.type === TokenType.EOF) break;
    const tStart = pointAt(buf.tracker, t.start);
    const tEnd = pointAt(buf.tracker, t.end);
    yield textEvent(t.start, t.end, pos(tStart, tEnd));
    advance(buf);
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
    while (peek(buf) !== null) {
      const t = peek(buf)!;
      if (t.type === TokenType.NEWLINE || t.type === TokenType.EOF) break;
      const tStart = pointAt(buf.tracker, t.start);
      const tEnd = pointAt(buf.tracker, t.end);
      yield textEvent(t.start, t.end, pos(tStart, tEnd));
      advance(buf);
    }

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
