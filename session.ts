/**
 * Basic stateful wrapper around the stateless parser pipeline.
 *
 * Most parser entry points stay stateless on purpose. They are easy to reason
 * about and easy to test. Some callers, especially editors and repeated-query
 * tooling, still want one object they can hold onto and ask for the outline,
 * full events, or full tree without recomputing each layer every time.
 *
 * Phase 5 keeps this wrapper intentionally small:
 *
 * ```text
 * createSession(source)
 *   ├─► session.outline()              -> cached block events
 *   ├─► session.events()               -> cached full events
 *   ├─► session.parse()                -> cached default tree
 *   ├─► session.parseWithDiagnostics() -> cached default tree + diagnostics
 *   ├─► session.parseStrictWithDiagnostics()
 *   │                                  -> cached conservative tree + diagnostics
 *   └─► session.parseWithRecovery()    -> cached default tree + recovery summary
 * ```
 *
 * Streaming writes and incremental edits belong to later phases. This file is
 * only the basic cached wrapper over the existing sync pipeline.
 *
 * @module
 */

import type { TextSource } from './text_source.ts';
import type { WikitextEvent } from './events.ts';
import type { WikistRoot } from './ast.ts';
import type { ParseDiagnosticsResult, ParseResult } from './tree_builder.ts';

import { blockEvents } from './block_parser.ts';
import { inlineEvents } from './inline_parser.ts';
import { tokenize } from './tokenizer.ts';
import { buildTree, buildTreeStrict, buildTreeWithDiagnostics, buildTreeWithRecovery } from './tree_builder.ts';

/**
 * Public switches for cached event-stream access.
 *
 * Sessions keep separate caches for diagnostics-off and diagnostics-on event
 * lanes. That lets callers stay on the cheapest stream path unless they
 * explicitly opt into diagnostics.
 */
export interface SessionStreamOptions {
  /** Whether the cached event lane should preserve parser diagnostics. */
  readonly diagnostics?: boolean;
}

/**
 * Cache-lane selector for the session wrapper.
 *
 * Sessions are not just memoizing one monolithic parse result. They keep
 * separate caches for the cheap tree-only lane and the diagnostics-enabled
 * lanes so callers do not accidentally pay for diagnostics they never asked
 * for.
 */
interface SessionEventOptions {
  /** Whether this lane wants event-level parser diagnostics preserved. */
  readonly diagnostics: boolean;
  /** Whether this lane wants the default or conservative tree materialization. */
  readonly recovery: 'default' | 'conservative';
}

/**
 * Basic stateful parser session.
 *
 * This interface is intentionally small. It is a cache wrapper around the
 * existing sync pipeline, not a long-lived mutable document model yet.
 *
 * A useful way to read it is as one cached pipeline with several result lanes:
 *
 * - `outline()` caches block structure
 * - `events()` reuses the outline cache and adds inline structure
 * - `parse()` reuses the full event cache and materializes the default tree
 * - `parseWithDiagnostics()` preserves diagnostics alongside that same tree
 * - `parseStrictWithDiagnostics()` materializes the conservative source-strict tree
 * - `parseWithRecovery()` keeps the default tree and adds an explicit boolean
 *   summary on top of its diagnostics
 *
 * The important design rule is that these are not separate parsers. They are
 * different materializations and summary shapes built from the same cached
 * outline and event work.
 */
export interface Session {
  /** Original source text backing this session. */
  readonly source: TextSource;

  /**
   * Return the cached block-only event stream.
   *
   * Call this when you only need document structure such as headings, lists,
   * tables, or paragraphs. It is the cheapest structured cache in the session.
   */
  outline(options?: SessionStreamOptions): Generator<WikitextEvent>;

  /**
   * Return the cached full event stream.
   *
   * This adds inline markup on top of the cached outline stage. Repeated calls
   * should not rerun block parsing for the same source.
   */
  events(options?: SessionStreamOptions): Generator<WikitextEvent>;

  /**
   * Return the cached parsed tree.
   *
  * This is the tree-only lane. If the caller also needs parser diagnostics or
  * explicit recovery metadata, use {@linkcode parseWithDiagnostics} or
  * {@linkcode parseWithRecovery}.
   */
  parse(): WikistRoot;

  /**
  * Return the cached parsed tree plus diagnostics.
  *
  * This is the diagnostics-first lane. It preserves diagnostics alongside the
  * same default tree shape returned by {@linkcode parse}.
  */
  parseWithDiagnostics(): ParseDiagnosticsResult;

  /**
   * Return the cached conservative tree-plus-diagnostics result.
   *
   * This lane uses the source-strict materialization policy. Recovery-heavy
   * wrappers are more likely to collapse back to plain text when the source did
   * not clearly commit to them.
   */
  parseStrictWithDiagnostics(): ParseDiagnosticsResult;

  /**
   * Return the cached parsed tree plus explicit recovery metadata.
   *
  * This is the recovery-aware lane for consumers that want the parser's
  * tolerant default behavior to stay explicit in their own control flow.
   */
  parseWithRecovery(): ParseResult;
}

/**
 * Concrete cache wrapper for one immutable source input.
 *
 * The caches are layered, but lane-aware rather than fully shared:
 *
 * ```text
 * diagnostics outline + default/conservative event caches -> diagnostics, conservative, and recovery results
 * cheap tree-only or reusable default events cache        -> parse()
 * ```
 *
 * That shape matters because it keeps `parse()` cheap when the caller does not
 * want diagnostics, while still reusing the more expensive diagnostics-aware
 * caches if some other consumer path already paid for them.
 *
 * Read the cache graph like this:
 *
 * - default outline and default events back the cheapest no-diagnostics lane
 * - diagnostics-enabled default events back both `parseWithDiagnostics()` and
 *   `parseWithRecovery()`
 * - conservative events back `parseStrictWithDiagnostics()`
 * - tree-level caches reuse whichever of those lanes already exists so one
 *   caller does not repay the same materialization cost twice
 */
class BasicSession implements Session {
  readonly source: TextSource;
  #outline_cache?: WikitextEvent[];
  #diagnostic_outline_cache?: WikitextEvent[];
  #event_cache?: WikitextEvent[];
  #diagnostic_event_cache?: WikitextEvent[];
  #conservative_event_cache?: WikitextEvent[];
  #tree_cache?: WikistRoot;
  #diagnostics_cache?: ParseDiagnosticsResult;
  #conservative_cache?: ParseDiagnosticsResult;
  #recovery_cache?: ParseResult;

  constructor(source: TextSource) {
    this.source = source;
  }

  *outline(options: SessionStreamOptions = {}): Generator<WikitextEvent> {
    yield* this.getOutlineCacheWithOptions({
      diagnostics: options.diagnostics === true,
      recovery: 'default',
    });
  }

  *events(options: SessionStreamOptions = {}): Generator<WikitextEvent> {
    yield* this.getEventsCache({
      diagnostics: options.diagnostics === true,
      recovery: 'default',
    });
  }

  /**
   * Materialize the cached tree-only result.
   *
    * If recovery was requested first, this reuses that already-materialized
    * default tree directly. Otherwise it builds from the cheap no-diagnostics
    * event lane.
    *
    * That split is deliberate. `parse()` is the "give me a usable tree and keep
    * overhead down" API, so it should not silently populate the more expensive
    * diagnostics-enabled caches unless some other consumer path already did that
    * work.
   */
  parse(): WikistRoot {
    if (this.#tree_cache === undefined) {
      if (this.#recovery_cache !== undefined) {
        this.#tree_cache = this.#recovery_cache.tree;
      } else if (this.#diagnostics_cache !== undefined) {
        this.#tree_cache = this.#diagnostics_cache.tree;
      } else {
        this.#tree_cache = buildTree(this.getEventsCache({
          diagnostics: false,
          recovery: 'default',
        }), { source: this.source });
      }
    }

    return this.#tree_cache;
  }

  /**
   * Materialize the cached tree-plus-diagnostics result.
   *
  * This lane caches separately because callers may ask for diagnostics before
  * any other tree result, but it preserves the same default tree shape as
  * {@linkcode parse}.
   */
  parseWithDiagnostics(): ParseDiagnosticsResult {
    if (this.#diagnostics_cache === undefined) {
      if (this.#recovery_cache !== undefined) {
        this.#diagnostics_cache = {
          tree: this.#recovery_cache.tree,
          diagnostics: this.#recovery_cache.diagnostics,
        };

        return this.#diagnostics_cache;
      }

      const result = buildTreeWithDiagnostics(this.getEventsCache({
        diagnostics: true,
        recovery: 'default',
      }), {
        source: this.source,
      });

      if (this.#tree_cache !== undefined) {
        this.#diagnostics_cache = {
          tree: this.#tree_cache,
          diagnostics: result.diagnostics,
        };
      } else {
        this.#diagnostics_cache = result;
      }
    }

    return this.#diagnostics_cache;
  }

  /**
  * Materialize the cached conservative tree-plus-diagnostics result.
  *
  * This is the only tree lane that needs the conservative event cache. The
  * default diagnostics lane and the recovery-summary lane can share the same
  * diagnostics-enabled default event stream.
   */
  parseStrictWithDiagnostics(): ParseDiagnosticsResult {
    if (this.#conservative_cache === undefined) {
      this.#conservative_cache = buildTreeStrict(this.getEventsCache({
        diagnostics: true,
        recovery: 'conservative',
      }), {
        source: this.source,
      });
    }

    return this.#conservative_cache;
  }

  /**
  * Materialize the cached tree-plus-recovery result.
   *
  * This lane shares the same default recovered tree as
  * {@linkcode parseWithDiagnostics}. Its only extra field is the `recovered`
  * summary boolean. That means it can reuse the diagnostics cache directly
  * when the caller already asked for diagnostics first.
   */
  parseWithRecovery(): ParseResult {
    if (this.#recovery_cache === undefined) {
      if (this.#diagnostics_cache !== undefined) {
        this.#recovery_cache = {
          tree: this.#diagnostics_cache.tree,
          diagnostics: this.#diagnostics_cache.diagnostics,
          recovered: this.#diagnostics_cache.diagnostics.length > 0,
        };
        this.#tree_cache = this.#diagnostics_cache.tree;

        return this.#recovery_cache;
      }

      const result = buildTreeWithRecovery(this.getEventsCache({
        diagnostics: true,
        recovery: 'default',
      }), {
        source: this.source,
      });

      if (this.#tree_cache !== undefined) {
        this.#recovery_cache = {
          tree: this.#tree_cache,
          recovered: result.recovered,
          diagnostics: result.diagnostics,
        };
      } else {
        this.#recovery_cache = result;
        this.#tree_cache = result.tree;
      }
    }

    return this.#recovery_cache;
  }

  /**
   * Return the appropriate outline cache for one session lane.
   *
   * Read the branching rule like this:
   *
   * ```text
  * diagnostics lane requested?
  *   yes -> use or build the diagnostics-enabled outline cache
  *   no  -> prefer the cheap outline cache, but reuse the diagnostics cache if
  *          it already exists because that work has already been paid for
   * ```
   */
  private getOutlineCacheWithOptions(options: SessionEventOptions): WikitextEvent[] {
    if (options.diagnostics) {
      if (this.#diagnostic_outline_cache === undefined) {
        this.#diagnostic_outline_cache = Array.from(blockEvents(this.source, tokenize(this.source), {
          diagnostics: true,
        }));
      }

      return this.#diagnostic_outline_cache;
    }

    if (this.#outline_cache !== undefined) {
      return this.#outline_cache;
    }

    if (this.#diagnostic_outline_cache !== undefined) {
      return this.#diagnostic_outline_cache;
    }

    this.#outline_cache = Array.from(
      blockEvents(this.source, tokenize(this.source), {
        diagnostics: false,
      }),
    );

    return this.#outline_cache;
  }

  /**
   * Return the appropriate full-event cache for one session lane.
   *
  * The same reuse rule as `getOutlineCacheWithOptions()` applies here. The
  * session preserves the cheap diagnostics-off lane when possible, but it does
  * not avoid reusing a more expensive cache once that cache already exists.
   */
  private getEventsCache(options: SessionEventOptions): WikitextEvent[] {
    if (options.diagnostics) {
      if (options.recovery === 'conservative') {
        if (this.#conservative_event_cache === undefined) {
          this.#conservative_event_cache = Array.from(eventsFromOutline(
            this.source,
            this.getOutlineCacheWithOptions(options),
            options,
          ));
        }

        return this.#conservative_event_cache;
      }

      if (this.#diagnostic_event_cache === undefined) {
        this.#diagnostic_event_cache = Array.from(eventsFromOutline(
          this.source,
          this.getOutlineCacheWithOptions(options),
          options,
        ));
      }

      return this.#diagnostic_event_cache;
    }

    if (this.#event_cache !== undefined) {
      return this.#event_cache;
    }

    if (this.#diagnostic_event_cache !== undefined) {
      return this.#diagnostic_event_cache;
    }

    this.#event_cache = Array.from(eventsFromOutline(
      this.source,
      this.getOutlineCacheWithOptions(options),
      options,
    ));

    return this.#event_cache;
  }
}

/**
 * Create a basic cached parser session.
 *
 * This is the entry point for repeated sync access to one immutable source.
 * It is useful for tooling that wants to ask several questions about the same
 * text without rebuilding every parser layer each time.
 */
export function createSession(source: TextSource): Session {
  return new BasicSession(source);
}

/**
 * Rebuild the full event stream from an already computed outline stream.
 *
 * Keeping this helper separate makes the cache layering explicit in
 * `BasicSession`: block parsing and inline parsing are distinct costs, and the
 * session deliberately tries not to repay the block cost once it has the
 * outline cache.
 *
 * That matters most for repeated editor-like queries such as:
 *
 * ```text
 * outline() -> events() -> parse()
 * ```
 *
 * where only the first step should need to pay the block-parser cost.
 */
function eventsFromOutline(
  source: TextSource,
  outline: Iterable<WikitextEvent>,
  options: SessionEventOptions,
): Generator<WikitextEvent> {
  return inlineEvents(source, outline, {
    diagnostics: options.diagnostics,
    recovery: options.recovery,
  });
}