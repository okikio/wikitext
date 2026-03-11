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
 *   ├─► session.parse()                -> cached loose tree
 *   ├─► session.parseWithDiagnostics() -> cached strict tree + diagnostics
 *   └─► session.parseWithRecovery()    -> cached recovered tree + recovery summary
 * ```
 *
 * `strict` and `loose` keep the same meaning here that they have in the
 * stateless APIs: they describe how much recovered structure remains visible
 * in the final tree, not whether parsing succeeded.
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
import { buildTree, buildTreeWithDiagnostics, buildTreeWithRecovery } from './tree_builder.ts';

/**
 * Cache-lane selector for the session wrapper.
 *
 * Sessions are not just memoizing one monolithic parse result. They keep
 * separate caches for the cheap tree-only lane and the diagnostics-enabled
 * lanes so callers do not accidentally pay for diagnostics they never asked
 * for.
 */
interface SessionEventOptions {
  /** Whether this lane wants event-level recovery diagnostics preserved. */
  readonly include_diagnostics: boolean;
  /** Whether this lane wants loose or strict recovery shape. */
  readonly recovery_style: 'loose' | 'strict';
}

/**
 * Basic stateful parser session.
 *
 * This interface is intentionally small. It is a cache wrapper around the
 * existing sync pipeline, not a long-lived mutable document model yet.
 *
 * A useful way to read it is:
 *
 * - `outline()` caches block structure
 * - `events()` reuses the outline cache and adds inline structure
 * - `parse()` reuses the full event cache and materializes the loose tree
 * - `parseWithDiagnostics()` preserves diagnostics alongside a stricter tree
 * - `parseWithRecovery()` keeps the more aggressively recovered tree and adds
 *   an explicit boolean summary on top of its diagnostics
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
  outline(): Generator<WikitextEvent>;

  /**
   * Return the cached full event stream.
   *
   * This adds inline markup on top of the cached outline stage. Repeated calls
   * should not rerun block parsing for the same source.
   */
  events(): Generator<WikitextEvent>;

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
  * This is the diagnostics-focused lane. It preserves recovery diagnostics and
  * returns a stricter tree without the extra boolean summary field.
  *
  * `strict` here means recovery-heavy wrappers may collapse back to plain text
  * when the source did not clearly commit to them.
  */
  parseWithDiagnostics(): ParseDiagnosticsResult;

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
 * diagnostics outline + strict/loose event caches -> diagnostics/recovery results
 * cheap tree-only or reusable loose events cache  -> parse()
 * ```
 *
 * That shape matters because it keeps `parse()` cheap when the caller does not
 * want diagnostics, while still reusing the more expensive diagnostics-aware
 * caches if some other consumer path already paid for them.
 */
class BasicSession implements Session {
  readonly source: TextSource;
  #outline_cache?: WikitextEvent[];
  #outline_without_diagnostics_cache?: WikitextEvent[];
  #strict_events_cache?: WikitextEvent[];
  #loose_events_cache?: WikitextEvent[];
  #events_without_diagnostics_cache?: WikitextEvent[];
  #tree_cache?: WikistRoot;
  #parse_diagnostics_cache?: ParseDiagnosticsResult;
  #parse_recovery_cache?: ParseResult;

  constructor(source: TextSource) {
    this.source = source;
  }

  *outline(): Generator<WikitextEvent> {
    yield* this.getOutlineCache();
  }

  *events(): Generator<WikitextEvent> {
    yield* this.getEventsCache({
      include_diagnostics: true,
      recovery_style: 'loose',
    });
  }

  /**
   * Materialize the cached tree-only result.
   *
    * If recovery was requested first, this reuses that already-materialized
    * loose tree directly. Otherwise it builds from the cheap no-diagnostics
    * event lane.
    *
    * That split is deliberate. `parse()` is the "give me a usable tree and keep
    * overhead down" API, so it should not silently populate the more expensive
    * diagnostics-enabled caches unless some other consumer path already did that
    * work.
   */
  parse(): WikistRoot {
    if (this.#tree_cache === undefined) {
      if (this.#parse_recovery_cache !== undefined) {
        this.#tree_cache = this.#parse_recovery_cache.tree;
      } else {
        this.#tree_cache = buildTree(this.getEventsCache({
          include_diagnostics: false,
          recovery_style: 'loose',
        }), { source: this.source });
      }
    }

    return this.#tree_cache;
  }

  /**
   * Materialize the cached tree-plus-diagnostics result.
   *
  * This lane caches separately from the loose tree because diagnostics can
   * intentionally strip recovery-created wrapper nodes back to plain text.
   */
  parseWithDiagnostics(): ParseDiagnosticsResult {
    if (this.#parse_diagnostics_cache === undefined) {
      const result = buildTreeWithDiagnostics(this.getEventsCache({
        include_diagnostics: true,
        recovery_style: 'strict',
      }), {
        source: this.source,
      });

      if (this.#tree_cache !== undefined && result.diagnostics.length === 0) {
        this.#parse_diagnostics_cache = {
          tree: this.#tree_cache,
          diagnostics: result.diagnostics,
        };
      } else {
        this.#parse_diagnostics_cache = result;
      }
    }

    return this.#parse_diagnostics_cache;
  }

  /**
   * Materialize the cached tree-plus-recovery result.
   *
  * If the loose tree was already requested, this preserves that exact
   * tree object and adds diagnostics around it.
   */
  parseWithRecovery(): ParseResult {
    if (this.#parse_recovery_cache === undefined) {
      const result = buildTreeWithRecovery(this.getEventsCache({
        include_diagnostics: true,
        recovery_style: 'loose',
      }), {
        source: this.source,
      });

      if (this.#tree_cache !== undefined) {
        this.#parse_recovery_cache = {
          tree: this.#tree_cache,
          recovered: result.recovered,
          diagnostics: result.diagnostics,
        };
      } else {
        this.#parse_recovery_cache = result;
        this.#tree_cache = result.tree;
      }
    }

    return this.#parse_recovery_cache;
  }

  /**
   * Populate or return the cached block-only event stream.
   */
  private getOutlineCache(): WikitextEvent[] {
    return this.getOutlineCacheWithOptions({
      include_diagnostics: true,
      recovery_style: 'loose',
    });
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
    if (options.include_diagnostics) {
      if (this.#outline_cache === undefined) {
        this.#outline_cache = Array.from(blockEvents(this.source, tokenize(this.source), {
          include_diagnostics: true,
        }));
      }

      return this.#outline_cache;
    }

    if (this.#outline_without_diagnostics_cache !== undefined) {
      return this.#outline_without_diagnostics_cache;
    }

    if (this.#outline_cache !== undefined) {
      return this.#outline_cache;
    }

    this.#outline_without_diagnostics_cache = Array.from(
      blockEvents(this.source, tokenize(this.source), {
        include_diagnostics: false,
      }),
    );

    return this.#outline_without_diagnostics_cache;
  }

  /**
   * Return the appropriate full-event cache for one session lane.
   *
   * The same reuse rule as `getOutlineCacheWithOptions()` applies here. The
   * session preserves the cheap parse lane when possible, but it does not avoid
   * reusing a more expensive cache once that cache already exists.
   */
  private getEventsCache(options: SessionEventOptions): WikitextEvent[] {
    if (options.include_diagnostics) {
      if (options.recovery_style === 'strict') {
        if (this.#strict_events_cache === undefined) {
          this.#strict_events_cache = Array.from(eventsFromOutline(
            this.source,
            this.getOutlineCacheWithOptions(options),
            options,
          ));
        }

        return this.#strict_events_cache;
      }

      if (this.#loose_events_cache === undefined) {
        this.#loose_events_cache = Array.from(eventsFromOutline(
          this.source,
          this.getOutlineCacheWithOptions(options),
          options,
        ));
      }

      return this.#loose_events_cache;
    }

    if (this.#events_without_diagnostics_cache !== undefined) {
      return this.#events_without_diagnostics_cache;
    }

    if (this.#loose_events_cache !== undefined) {
      return this.#loose_events_cache;
    }

    this.#events_without_diagnostics_cache = Array.from(eventsFromOutline(
      this.source,
      this.getOutlineCacheWithOptions(options),
      options,
    ));

    return this.#events_without_diagnostics_cache;
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
    include_diagnostics: options.include_diagnostics,
    recovery_style: options.recovery_style,
  });
}