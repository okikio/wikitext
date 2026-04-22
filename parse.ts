/**
 * Public orchestration helpers for the parser pipeline.
 *
 * The lower-level modules already expose each pipeline stage separately:
 * tokenizer, block parser, and inline parser. This file adds the sync pull API
 * that most callers want when they do not need to wire stages together by
 * hand.
 *
 * The functions intentionally mirror the pipeline layers:
 *
 * ```text
 * tokens(source)               -> raw tokenizer output
 * outlineEvents(source)        -> block structure only
 * events(source)               -> block + inline event stream
 * parse(source)                -> default tree
 * parseWithDiagnostics(source) -> default tree + diagnostics
 * parseStrictWithDiagnostics(source) -> conservative tree + diagnostics
 * parseWithRecovery(source)    -> default tree + recovered + diagnostics
 * ```
 *
 * The key split is now diagnostic emission first, then materialization policy.
 * If a caller does not want diagnostics, the block and inline stages should
 * not emit diagnostic events for that lane.
 *
 * @example Walking the full event stream
 * ```ts
 * import { events } from './parse.ts';
 *
 * for (const event of events("A [[Page|link]]")) {
 *   console.log(event.kind);
 * }
 * ```
 *
 * @module
 */

import type { Token } from './token.ts';
import type { WikitextEvent } from './events.ts';
import type { TextSource } from './text_source.ts';
import type { WikistRoot } from './ast.ts';
import type { ParseDiagnosticsResult, ParseResult } from './tree_builder.ts';

import { tokenize } from './tokenizer.ts';
import { blockEvents } from './block_parser.ts';
import { inlineEvents } from './inline_parser.ts';
import { buildTree, buildTreeStrict, buildTreeWithDiagnostics, buildTreeWithRecovery } from './tree_builder.ts';

/**
 * Public switches for event-stream production.
 *
 * The main cost choice here is whether parser diagnostics should be emitted at
 * all. If `diagnostics` is omitted or `false`, the block and inline
 * stages stay on the cheapest event lane and do not emit `error` events.
 */
export interface EventOptions {
  /** Whether block and inline stages should emit diagnostic events. */
  readonly diagnostics?: boolean;
}

/**
 * Internal event-pipeline switches used to keep the public API cost-aware.
 *
 * The parser exposes one default tree lane and two diagnostics-preserving
 * variants built on the same event pipeline.
 *
 * ```text
 * parse()                -> default tree, no diagnostics
 * parseWithDiagnostics() -> default tree + diagnostics
 * parseStrictWithDiagnostics()
 *                        -> conservative tree + diagnostics
 * parseWithRecovery()    -> default tree + diagnostics + recovered summary
 * ```
 *
 * These options are the plumbing that keeps those lanes honest. Without them,
 * the public API would expose different result shapes while still paying for
 * the same underlying work.
 */
interface EventPipelineOptions {
  /** Whether block and inline stages should emit parser diagnostics. */
  readonly diagnostics?: boolean;
  /** Whether malformed inline/tree regions keep the default tree overlay or collapse to text. */
  readonly recovery?: 'default' | 'conservative';
}

/**
 * Yield the raw token stream for one source input.
 *
 * This is the cheapest parser entry point. It is useful for search, grep-like
 * tooling, and low-level diagnostics that do not need structural nesting.
 */
export function tokens(source: TextSource): Generator<Token> {
  return tokenize(source);
}

/**
 * Yield block-level events only.
 *
 * Inline content remains plain text ranges. This is the cheap structural mode
 * for outlines, table-of-contents extraction, and other block-focused tools.
 */
export function outlineEvents(
  source: TextSource,
  options: EventOptions = {},
): Generator<WikitextEvent> {
  return outlineEventsWithOptions(source, options);
}

/**
 * Yield the full event stream for one source input.
 *
 * This is the default event-level API. It runs the tokenizer, block parser,
 * and inline enrichment in order.
 */
export function events(
  source: TextSource,
  options: EventOptions = {},
): Generator<WikitextEvent> {
  return eventsWithOptions(source, {
    diagnostics: options.diagnostics,
    recovery: 'default',
  });
}

function outlineEventsWithOptions(
  source: TextSource,
  options: EventPipelineOptions,
): Generator<WikitextEvent> {
  return blockEvents(source, tokenize(source), {
    diagnostics: options.diagnostics,
  });
}

/**
 * Build the full event stream with one specific cost/behavior lane.
 *
 * This helper keeps the public wrappers small and makes the block/inline split
 * explicit: first get block structure, then enrich it with inline markup.
 */
function eventsWithOptions(
  source: TextSource,
  options: EventPipelineOptions,
): Generator<WikitextEvent> {
  return eventsFromOutline(
    source,
    outlineEventsWithOptions(source, options),
    options,
  );
}

/**
 * Enrich an existing block-event iterable with inline markup.
 *
 * This internal helper lets higher-level wrappers such as `Session` reuse a
 * cached outline stream instead of rerunning the block parser just to reach the
 * full event stream.
 */
function eventsFromOutline(
  source: TextSource,
  outline: Iterable<WikitextEvent>,
  options: EventPipelineOptions,
): Generator<WikitextEvent> {
  return inlineEvents(source, outline, {
    diagnostics: options.diagnostics,
    recovery: options.recovery,
  });
}

/**
 * Parse source text into a wikist tree.
 *
 * This is the convenience API for callers that want a full AST and do not need
 * to inspect the intermediate event stream themselves.
 *
 * It is also the cheapest tree-building lane. It does not request diagnostics
 * from the block or inline stages, and it keeps the default tolerant
 * HTML-like tree shape when malformed input is encountered.
 *
 * If the caller also needs diagnostics or explicit recovery metadata, use
 * {@linkcode parseWithDiagnostics} or {@linkcode parseWithRecovery} instead.
 */
export function parse(source: TextSource): WikistRoot {
  return buildTree(eventsWithOptions(source, {
    diagnostics: false,
    recovery: 'default',
  }), { source });
}

/**
 * Parse source text into the default wikist tree and keep diagnostics.
 *
 * This is the diagnostics-first entry point. It preserves the same default
 * HTML-like tree shape as {@linkcode parse}, but also returns the diagnostics
 * that describe malformed input and parser continuation points.
 */
export function parseWithDiagnostics(source: TextSource): ParseDiagnosticsResult {
  return buildTreeWithDiagnostics(eventsWithOptions(source, {
    diagnostics: true,
    recovery: 'default',
  }), { source });
}

/**
 * Parse source text into a conservative tree and keep diagnostics.
 *
 * This is the source-strict materialization lane. It still keeps diagnostics
 * and still follows the never-throw contract, but recovery-heavy wrappers are
 * more likely to collapse back to plain text when the source never clearly
 * committed to them.
 */
export function parseStrictWithDiagnostics(source: TextSource): ParseDiagnosticsResult {
  return buildTreeStrict(eventsWithOptions(source, {
    diagnostics: true,
    recovery: 'conservative',
  }), { source });
}

/**
 * Parse source text into a wikist tree and report whether recovery happened.
 *
 * This is the explicit recovery-aware entry point. It returns the same
 * default tree as {@linkcode parse}, plus a `recovered` flag and the
 * diagnostics that explain what the parser had to do on the caller's behalf.
 *
 * Read the result like two coordinated lanes:
 *
 * ```text
 * source
 *   ├─► parse()                 -> tree only
 *   ├─► parseWithDiagnostics()  -> tree + diagnostics
 *   ├─► parseStrictWithDiagnostics()
 *   │                          -> conservative tree + diagnostics
 *   └─► parseWithRecovery()     -> tree + recovered + diagnostics
 * ```
 *
 * The important distinction from `parseWithDiagnostics()` is not just the
 * extra boolean. This lane adds an explicit summary field for consumers that
 * want the parser's tolerant default behavior to stay visible in control flow.
 *
 * The diagnostics include a narrow `anchor` so downstream tools can resolve
 * the nearest node around the recovery point.
 *
 * Today those diagnostics mostly come from block-parser findings and
 * tree-builder continuation steps. `parse()` intentionally drops them,
 * `parseWithDiagnostics()` preserves them with the default tree, and
 * `parseWithRecovery()` adds the explicit `recovered` summary.
 *
 * That anchor is intentionally tree-only today. Edit-stable anchor semantics
 * belong to later session/edit tracking work and are not part of this public
 * API yet.
 */
export function parseWithRecovery(source: TextSource): ParseResult {
  return buildTreeWithRecovery(eventsWithOptions(source, {
    diagnostics: true,
    recovery: 'default',
  }), { source });
}