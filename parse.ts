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
 * parse(source)                -> loose full tree
 * parseWithDiagnostics(source) -> strict tree + diagnostics
 * parseWithRecovery(source)    -> recovered tree + recovered + diagnostics
 * ```
 *
 * `strict` and `loose` describe recovery shape, not parser acceptance. Both
 * lanes still recover and still return a valid tree.
 *
 * That keeps the cost model visible. Callers can stop at the cheapest layer
 * that answers their question instead of always paying for a full tree.
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
import { buildTree, buildTreeWithDiagnostics, buildTreeWithRecovery } from './tree_builder.ts';

/**
 * Internal event-pipeline switches used to keep the public API cost-aware.
 *
 * The parser has three public tree lanes:
 *
 * ```text
 * parse()                -> no diagnostics, loose recovery shape
 * parseWithDiagnostics() -> diagnostics on, strict recovery shape
 * parseWithRecovery()    -> diagnostics on, loose recovery shape
 * ```
 *
 * These options are the plumbing that keeps those lanes honest. Without them,
 * the public API would expose different result shapes while still paying for
 * the same underlying work.
 */
interface EventPipelineOptions {
  /** Whether block and inline stages should emit recovery diagnostics. */
  readonly include_diagnostics?: boolean;
  /** Whether recoverable inline/tree structures stay loose or collapse to text. */
  readonly recovery_style?: 'loose' | 'strict';
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
export function outlineEvents(source: TextSource): Generator<WikitextEvent> {
  return outlineEventsWithOptions(source, {
    include_diagnostics: true,
  });
}

/**
 * Yield the full event stream for one source input.
 *
 * This is the default event-level API. It runs the tokenizer, block parser,
 * and inline enrichment in order.
 */
export function events(source: TextSource): Generator<WikitextEvent> {
  return eventsWithOptions(source, {
    include_diagnostics: true,
    recovery_style: 'loose',
  });
}

function outlineEventsWithOptions(
  source: TextSource,
  options: EventPipelineOptions,
): Generator<WikitextEvent> {
  return blockEvents(source, tokenize(source), {
    include_diagnostics: options.include_diagnostics,
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
    include_diagnostics: options.include_diagnostics,
    recovery_style: options.recovery_style,
  });
}

/**
 * Parse source text into a wikist tree.
 *
 * This is the convenience API for callers that want a full AST and do not need
 * to inspect the intermediate event stream themselves.
 *
 * It is also the cheapest tree-building lane. It does not request recovery
 * diagnostics from the block or inline stages, and it keeps the loose tree
 * shape when recovery is needed internally.
 *
 * `loose` means the final tree keeps more recovered wrapper structure when the
 * parser can still infer something usable from the source.
 *
 * If the caller also needs diagnostics or explicit recovery metadata, use
 * {@linkcode parseWithDiagnostics} or {@linkcode parseWithRecovery} instead.
 */
export function parse(source: TextSource): WikistRoot {
  return buildTree(eventsWithOptions(source, {
    include_diagnostics: false,
    recovery_style: 'loose',
  }), { source });
}

/**
 * Parse source text into a strict wikist tree and keep recovery diagnostics.
 *
 * This is the diagnostics-focused entry point. It returns a stricter
 * tree than {@linkcode parse} when recovery would otherwise synthesize wrapper
 * nodes, plus the diagnostics that explain those recovery points.
 *
 * `strict` means the final tree is stricter about preserving only structure
 * that the source clearly committed to. Recovery still happens, but
 * recovery-heavy wrappers are more likely to collapse back to plain text.
 *
 * In practical terms, this is the lane to use when a caller wants to surface
 * problems to a user, lint malformed input, or inspect where recovery happened
 * without fully committing to the loose recovered shape.
 */
export function parseWithDiagnostics(source: TextSource): ParseDiagnosticsResult {
  return buildTreeWithDiagnostics(eventsWithOptions(source, {
    include_diagnostics: true,
    recovery_style: 'strict',
  }), { source });
}

/**
 * Parse source text into a wikist tree and report whether recovery happened.
 *
 * This is the explicit recovery-aware entry point. It returns the same
 * loose tree as {@linkcode parse}, plus a `recovered` flag and the
 * diagnostics that explain what the parser had to do on the caller's behalf.
 *
 * Read the result like two coordinated lanes:
 *
 * ```text
 * source
 *   ├─► parse()                 -> loose tree only
 *   ├─► parseWithDiagnostics()  -> strict tree + diagnostics
 *   └─► parseWithRecovery()     -> recovered tree + recovered + diagnostics
 * ```
 *
 * The important distinction from `parseWithDiagnostics()` is not just the
 * extra boolean. This lane also keeps the loose recovered tree itself.
 * That makes it the right fit for tolerant rendering, content transforms, or
 * downstream tools that want best-effort structure plus an explicit signal
 * that recovery happened.
 *
 * The diagnostics include a narrow `anchor` so downstream tools can resolve
 * the nearest node around the recovery point.
 *
 * Today those diagnostics mostly come from block-parser recovery events and
 * tree-builder recovery steps. `parse()` intentionally drops them,
 * `parseWithDiagnostics()` preserves them while stripping recovery-created
 * wrapper nodes back to strict text ranges where possible, and
 * `parseWithRecovery()` keeps the more aggressively recovered tree plus the
 * explicit `recovered` summary.
 *
 * That anchor is intentionally tree-only today. Edit-stable anchor semantics
 * belong to later session/edit tracking work and are not part of this public
 * API yet.
 */
export function parseWithRecovery(source: TextSource): ParseResult {
  return buildTreeWithRecovery(eventsWithOptions(source, {
    include_diagnostics: true,
    recovery_style: 'loose',
  }), { source });
}