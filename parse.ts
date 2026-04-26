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
 * analyze(source)              -> replayable findings (events + diagnostics +
 *                                 recovery list)
 * materialize(findings)        -> tree + diagnostics for one policy choice
 * ```
 *
 * The key split is now diagnostic emission first, then materialization policy.
 * If a caller does not want diagnostics, the block and inline stages should
 * not emit diagnostic events for that lane.
 *
 * The event stream itself stays policy-neutral. The default tree family and
 * the conservative tree are both materializations of the same parser findings.
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
import type { WikistNodeType, WikistRoot } from './ast.ts';
import type {
  ParseDiagnostic,
  ParseDiagnosticAnchor,
  ParseDiagnosticsResult,
  ParseResult,
  TreeMaterializationPolicy,
} from './tree_builder.ts';
import type { Position } from './events.ts';
import { DiagnosticCode, type KnownDiagnosticCode } from './events.ts';

import { tokenize } from './tokenizer.ts';
import { blockEvents } from './block_parser.ts';
import { inlineEvents } from './inline_parser.ts';
import {
  buildTree,
  buildTreeStrict,
  buildTreeWithDiagnostics,
  buildTreeWithRecovery,
  TreeMaterializationPolicy as TreeMaterializationPolicyMap,
} from './tree_builder.ts';

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
 * Internal event-pipeline switches used by the tree wrappers in this module.
 *
 * The parser exposes one shared event pipeline and several tree lanes layered
 * on top of it.
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
 *
 * @internal
 */
export interface EventPipelineOptions {
  /** Whether block and inline stages should emit parser diagnostics. */
  readonly diagnostics?: boolean;
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
  });
}

/**
 * @internal
 * Build the block-only event stream for one diagnostics choice.
 */
export function outlineEventsWithOptions(
  source: TextSource,
  options: EventPipelineOptions,
): Generator<WikitextEvent> {
  return blockEvents(source, tokenize(source), {
    diagnostics: options.diagnostics,
  });
}

/**
 * Build the full event stream for one diagnostics choice.
 *
 * This helper keeps the public wrappers small and makes the block/inline split
 * explicit: first get block structure, then enrich it with inline markup.
 * Materialization policy is intentionally not part of this step.
 *
 * @internal
 */
export function eventsWithOptions(
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
 * Rebuild the full event stream from a previously computed outline stream.
 *
 * This helper lets higher-level wrappers such as `Session` reuse a cached
 * outline stream instead of rerunning the block parser just to reach the full
 * event stream.
 *
 * @internal
 */
export function eventsFromOutline(
  source: TextSource,
  outline: Iterable<WikitextEvent>,
  options: EventPipelineOptions,
): Generator<WikitextEvent> {
  return inlineEvents(source, outline, {
    diagnostics: options.diagnostics,
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
  }), { source });
}

/**
 * Parse source text into a conservative tree and keep diagnostics.
 *
 * This is the source-strict materialization lane. It uses the same parser
 * findings as {@linkcode parseWithDiagnostics}, but it collapses recovery-heavy
 * wrappers back to plain text during tree materialization when the source never
 * clearly committed to them.
 */
export function parseStrictWithDiagnostics(source: TextSource): ParseDiagnosticsResult {
  return buildTreeStrict(eventsWithOptions(source, {
    diagnostics: true,
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
  }), { source });
}

// ---------------------------------------------------------------------------
// Findings-first lane: analyze() + materialize()
// ---------------------------------------------------------------------------
//
// The tree-first wrappers above bake one materialization policy into each
// result. That is fine for most consumers, but some tools want to see the
// parser's findings first and then decide how to turn them into a tree (or
// decide whether to build a tree at all).
//
// ```text
// analyze(source)            collect events + diagnostics + recovery list
//   │
//   ├─► materialize(findings)                 default-html-like tree
//   └─► materialize(findings, { policy })     pick a policy per call
// ```
//
// Findings are replayable on purpose. A caller can ask the same findings
// object for more than one materialization without reparsing the source.

/**
 * Structured recovery classes the parser currently knows how to describe.
 *
 * This vocabulary is intentionally small. Each kind names one decision the
 * parser had to make while continuing through malformed input, so later
 * tooling can inspect recovery without matching on long human-readable
 * messages.
 *
 * The kinds are:
 *
 * - `missing-close`: an inline opener was complete but its matching close
 *   never arrived before the enclosing text range ended.
 * - `unterminated-opener`: an inline opener started but never reached its
 *   closing `>`.
 * - `unclosed-table`: a block-level table opened but never closed.
 * - `mismatched-exit`: an `exit` event referenced a node that was not the
 *   innermost open frame, so the tree builder auto-closed one or more inner
 *   frames before honoring it.
 * - `orphan-exit`: an `exit` event referenced no currently open frame.
 * - `eof-autoclose`: the event stream ended while one or more frames were
 *   still open.
 */
export type ParseRecoveryKind =
  | 'missing-close'
  | 'unterminated-opener'
  | 'unclosed-table'
  | 'mismatched-exit'
  | 'orphan-exit'
  | 'eof-autoclose';

/**
 * One structural recovery decision the parser made while analyzing the source.
 *
 * A `ParseRecovery` is the narrower, taxonomy-oriented cousin of
 * {@linkcode ParseDiagnostic}. Diagnostics carry a human-readable message and
 * are useful for logs and editor hints. Recovery entries are the replayable
 * decisions those diagnostics describe: what kind of malformed region was
 * encountered, where it lives, and which materialization policies can change
 * how it ends up in a final tree.
 *
 * `policies` is the list of package-owned materialization policies that
 * produce a distinct outcome for this recovery. When both public policies
 * would render the region the same way (for example, an unterminated opener
 * stays as text under either policy), only `DEFAULT_HTML_LIKE` is listed.
 */
export interface ParseRecovery {
  /** Classifier for this recovery. */
  readonly kind: ParseRecoveryKind;
  /** Underlying diagnostic code that triggered the recovery. */
  readonly code: KnownDiagnosticCode | string;
  /** Source position where the recovery was recorded. */
  readonly position: Position;
  /** Tree-path anchor resolved against the default materialization. */
  readonly anchor: ParseDiagnosticAnchor;
  /** Node type involved in the recovery, when the parser knows it. */
  readonly node_type?: WikistNodeType;
  /** Package-owned materialization policies that can change the final shape. */
  readonly policies: readonly TreeMaterializationPolicy[];
}

/**
 * Options for {@linkcode analyze}.
 *
 * Recovery-list construction is cheap, but it is still opt-out for callers
 * that only want events and diagnostics.
 */
export interface AnalyzeOptions {
  /**
   * Whether to include the derived `recovery` array on the returned findings.
   *
   * Defaults to `true`. Set to `false` when only events and diagnostics are
   * needed.
   */
  readonly recovery?: boolean;
}

/**
 * Replayable parser findings for one source input.
 *
 * `ParseFindings` is the public shape the findings-first lane returns. It is
 * intentionally narrow:
 *
 * - `events` is a fully collected array, so downstream tools can replay the
 *   stream more than once without reparsing the source
 * - `diagnostics` are preserved in the shape downstream tools already
 *   understand, including tree-anchor metadata
 * - `recovery` lists the structural decisions the parser had to make, when
 *   {@linkcode AnalyzeOptions.recovery} is not turned off
 *
 * The findings object does not include a tree on purpose. A caller chooses
 * when (and whether) to materialize one by passing the findings to
 * {@linkcode materialize}.
 */
export interface ParseFindings {
  /** Original source text backing the findings. */
  readonly source: TextSource;
  /** Collected event stream, ready to replay. */
  readonly events: readonly WikitextEvent[];
  /** Diagnostics discovered while analyzing the source. */
  readonly diagnostics: readonly ParseDiagnostic[];
  /** Structural recovery decisions, when requested. */
  readonly recovery?: readonly ParseRecovery[];
}

/**
 * Options for {@linkcode materialize}.
 *
 * The policy selection here mirrors the wrappers exposed by
 * {@linkcode parseWithDiagnostics} and {@linkcode parseStrictWithDiagnostics},
 * but the caller stays in control of when materialization happens.
 */
export interface MaterializeOptions {
  /**
   * Tree-shaping policy for this materialization.
   *
   * Defaults to `TreeMaterializationPolicy.DEFAULT_HTML_LIKE`.
   */
  readonly policy?: TreeMaterializationPolicy;
}

/**
 * Result of one {@linkcode materialize} call.
 *
 * This is the same shape as {@linkcode ParseDiagnosticsResult}. It is given a
 * dedicated name here so the findings-first lane reads cleanly: findings go
 * in, a tree plus diagnostics come out.
 */
export interface ParseOutput {
  /** Materialized wikist tree for the requested policy. */
  readonly tree: WikistRoot;
  /** Diagnostics produced by this materialization. */
  readonly diagnostics: readonly ParseDiagnostic[];
}

/**
 * Analyze source text into replayable parser findings.
 *
 * This is the findings-first lane. It runs the event pipeline with
 * diagnostics enabled, collects the events into an array so they can be
 * replayed, and summarizes the parser's recovery decisions.
 *
 * Use this when a caller wants to inspect what the parser found before
 * deciding whether (or how) to materialize a tree. A common pattern is to
 * analyze once and materialize several times with different policies:
 *
 * ```ts
 * const findings = analyze(source);
 *
 * if (findings.recovery?.length) {
 *   // Show diagnostics, or collapse recovery-heavy regions.
 *   const strict = materialize(findings, {
 *     policy: TreeMaterializationPolicy.SOURCE_STRICT,
 *   });
 * }
 *
 * const tolerant = materialize(findings);
 * ```
 *
 * Diagnostics in the returned findings are computed against the default
 * tolerant tree shape, so their `anchor` paths resolve against a
 * `DEFAULT_HTML_LIKE` materialization. Calling {@linkcode materialize} with
 * `SOURCE_STRICT` returns its own diagnostics with anchors retargeted to the
 * conservative tree.
 */
export function analyze(
  source: TextSource,
  options: AnalyzeOptions = {},
): ParseFindings {
  const events = Array.from(eventsWithOptions(source, { diagnostics: true }));
  const { diagnostics } = buildTreeWithDiagnostics(events, { source });

  if (options.recovery === false) {
    return {
      source,
      events,
      diagnostics,
    };
  }

  return {
    source,
    events,
    diagnostics,
    recovery: recoveriesFromDiagnostics(diagnostics),
  };
}

/**
 * Materialize a wikist tree from previously analyzed findings.
 *
 * This is the consumer side of the findings-first lane. It takes an existing
 * {@linkcode ParseFindings} object and builds a tree under the requested
 * materialization policy. The findings can be replayed more than once, which
 * means a caller can materialize the same parse under different policies
 * without repeating tokenizer or block-parser work.
 *
 * When the policy is omitted, the default tolerant HTML-like materialization
 * is used, so this call produces the same tree as {@linkcode parseWithDiagnostics}
 * would for the same source.
 */
export function materialize(
  findings: ParseFindings,
  options: MaterializeOptions = {},
): ParseOutput {
  const policy = options.policy ?? TreeMaterializationPolicyMap.DEFAULT_HTML_LIKE;

  if (policy === TreeMaterializationPolicyMap.SOURCE_STRICT) {
    return buildTreeStrict(findings.events, { source: findings.source });
  }

  return buildTreeWithDiagnostics(findings.events, { source: findings.source });
}

/**
 * Derive a structured recovery list from a set of diagnostics.
 *
 * Only diagnostics that describe one of the parser's known structural
 * recoveries map to a {@linkcode ParseRecovery} entry. Other diagnostics
 * (including non-recoverable ones or future codes without a recovery
 * classification) are skipped so the recovery vocabulary stays narrow.
 *
 * @internal Exposed so `Session` can derive recovery entries from its
 * already-cached diagnostics without a redundant tree walk.
 */
export function recoveriesFromDiagnostics(
  diagnostics: readonly ParseDiagnostic[],
): readonly ParseRecovery[] {
  const recoveries: ParseRecovery[] = [];

  for (const diagnostic of diagnostics) {
    const kind = recoveryKindForCode(diagnostic.code);
    if (kind === undefined) continue;

    const entry: ParseRecovery = {
      kind,
      code: diagnostic.code ?? '',
      position: diagnostic.position,
      anchor: diagnostic.anchor,
      policies: recoveryPoliciesForCode(diagnostic.code),
      ...(diagnostic.anchor.node_type !== 'root'
        ? { node_type: diagnostic.anchor.node_type }
        : {}),
    };

    recoveries.push(entry);
  }

  return recoveries;
}

/**
 * Map a diagnostic code to its structural recovery classifier.
 *
 * Returns `undefined` for diagnostics that do not describe a tree-shape
 * decision (for example, future non-structural diagnostic codes), so the
 * recovery list only contains entries that tools can act on.
 */
function recoveryKindForCode(
  code: KnownDiagnosticCode | string | undefined,
): ParseRecoveryKind | undefined {
  switch (code) {
    case DiagnosticCode.INLINE_TAG_MISSING_CLOSE:
      return 'missing-close';
    case DiagnosticCode.INLINE_TAG_UNTERMINATED_OPENER:
      return 'unterminated-opener';
    case DiagnosticCode.UNCLOSED_TABLE:
      return 'unclosed-table';
    case DiagnosticCode.TREE_MISMATCHED_EXIT:
      return 'mismatched-exit';
    case DiagnosticCode.TREE_ORPHAN_EXIT:
      return 'orphan-exit';
    case DiagnosticCode.TREE_EOF_AUTOCLOSE:
      return 'eof-autoclose';
    default:
      return undefined;
  }
}

/**
 * List the materialization policies that can change the final shape for one
 * diagnostic code.
 *
 * For recovery-heavy wrappers that source-strict materialization collapses
 * back to text (for example, `INLINE_TAG_MISSING_CLOSE` or `UNCLOSED_TABLE`),
 * both public policies are listed because switching policy produces a
 * different tree. For codes where both policies produce the same outcome,
 * only the default policy is listed to make it obvious that policy choice is
 * not meaningful here.
 */
function recoveryPoliciesForCode(
  code: KnownDiagnosticCode | string | undefined,
): readonly TreeMaterializationPolicy[] {
  switch (code) {
    case DiagnosticCode.INLINE_TAG_MISSING_CLOSE:
    case DiagnosticCode.UNCLOSED_TABLE:
    case DiagnosticCode.TREE_MISMATCHED_EXIT:
    case DiagnosticCode.TREE_EOF_AUTOCLOSE:
      return [
        TreeMaterializationPolicyMap.DEFAULT_HTML_LIKE,
        TreeMaterializationPolicyMap.SOURCE_STRICT,
      ];
    default:
      return [TreeMaterializationPolicyMap.DEFAULT_HTML_LIKE];
  }
}