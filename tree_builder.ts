/**
 * Build a wikist tree from the parser's event stream.
 *
 * The parser's core pipeline is events-first, not tree-first. That keeps the
 * hot path cheaper for consumers that only need a stream. The tree builder is
 * the stage that materializes those events into nested Wikist nodes when a
 * caller does want an object graph it can walk later.
 *
 * One detail matters here: text events are range-first. They carry source
 * offsets, not copied strings. That is great for the parser pipeline, but a
 * `Text` node needs a real `value` string. For that reason, `buildTree()`
 * takes the original `source` alongside the event iterable.
 *
 * Read the conversion like this:
 *
 * ```text
 * event stream
 *   ├─► enter(node)  -> push frame
 *   ├─► text(range)  -> slice source, append Text child
 *   └─► exit(node)   -> pop frame, attach finished node to parent
 * ```
 *
 * The tree builder keeps tree shape, diagnostics, and recovery metadata as
 * separate result lanes.
 * `buildTree()` returns the default tolerant tree. `buildTreeWithDiagnostics()`
 * keeps that same tree shape while preserving diagnostics.
 * `buildTreeStrict()` is the conservative materialization lane that collapses
 * recovery-heavy wrappers back to plain text when the source never clearly
 * committed to them. `buildTreeWithRecovery()` adds an explicit `recovered`
 * summary on top of the default diagnostics lane.
 *
 * @example Building a tree from the full event pipeline
 * ```ts
 * import { buildTree } from './tree_builder.ts';
 * import { events } from './parse.ts';
 *
 * const source = "== Title ==\n\nA [[Page|link]].";
 * const tree = buildTree(events(source), { source });
 * ```
 *
 * @module
 */

import type {
  DiagnosticSeverity,
  ErrorEvent,
  KnownDiagnosticCode,
  Position,
  WikitextEvent,
} from './events.ts';
import type { TextSource } from './text_source.ts';
import type { Point } from './events.ts';
import type { WikistNode, WikistNodeType, WikistRoot } from './ast.ts';
import { DiagnosticCode } from './events.ts';
import { slice } from './text_source.ts';

/**
 * Options for {@linkcode buildTree}.
 *
 * The event iterable alone is not enough to materialize literal node values,
 * because text events only carry source offsets. The original source is the
 * extra input that lets the tree builder turn those ranges back into strings.
 */
export interface BuildTreeOptions {
  /**
   * Original source text for resolving text-event ranges into node values.
   */
  readonly source: TextSource;
}

/**
 * Accumulator frame for the final document root.
 *
 * This is separate from `NodeFrame` because incoming `enter('root')` and
 * `exit('root')` events are treated as boundary markers, not as a child node
 * that should be pushed and popped on the main node stack.
 */
interface RootFrame {
  /** Discriminant for stack narrowing. */
  readonly kind: 'root';
  /** Top-level children collected while walking the stream. */
  readonly children: WikistNode[];
  /** Start point from `enter('root')` when present in the event stream. */
  start_point?: Point;
  /** End point from `exit('root')` when present in the event stream. */
  end_point?: Point;
}

/**
 * Stack frame for one non-root node currently being materialized.
 *
 * Think of this as the builder's in-progress node record: we capture opening
 * metadata on enter, append children while nested events arrive, and finalize
 * the node when a matching or recovery-triggered exit is seen.
 */
interface NodeFrame {
  /** Discriminant for stack narrowing. */
  readonly kind: 'node';
  /** Node type opened by the corresponding enter event. */
  readonly node_type: Exclude<WikistNodeType, 'root' | 'text'>;
  /** Props captured from the enter event and forwarded at finalize time. */
  readonly props: Readonly<Record<string, unknown>>;
  /** Opening point captured from the enter event. */
  readonly start: Point;
  /**
   * Fallback end point when the stream ends before a matching exit arrives.
   */
  readonly default_end: Point;
  /** Whether this node type accepts child nodes in the wikist model. */
  readonly accepts_children: boolean;
  /** Child nodes accumulated while this frame stays open on the stack. */
  readonly children: WikistNode[];
  /** Whether this frame should materialize back into plain source text. */
  recover_as_text?: boolean;
}

/** Active builder stack item used during event-to-tree conversion. */
type TreeFrame = RootFrame | NodeFrame;

/**
 * Stable materialization-policy names for consumers that want to refer to the
 * parser's public tree-shaping policies without hard-coding string literals.
 */
/** Public map shape for the parser's stable tree-materialization policies. */
export type TreeMaterializationPolicyMap = Readonly<{
  DEFAULT_HTML_LIKE: 'default-html-like';
  SOURCE_STRICT: 'source-strict';
}>;

const TREE_MATERIALIZATION_POLICY_VALUES: TreeMaterializationPolicyMap = {
  /** Keep the parser's default tolerant HTML-like materialization. */
  DEFAULT_HTML_LIKE: 'default-html-like',
  /** Collapse recovery-heavy wrappers back to plain source-backed text. */
  SOURCE_STRICT: 'source-strict',
} as const;

/**
 * Stable materialization-policy names for the parser's public tree-shaping
 * policies.
 */
export const TreeMaterializationPolicy: TreeMaterializationPolicyMap = Object.freeze(
  TREE_MATERIALIZATION_POLICY_VALUES,
);

/** Public names for the tree materialization policies exposed by this module. */
export type TreeMaterializationPolicy =
  typeof TreeMaterializationPolicy[keyof typeof TreeMaterializationPolicy];

const PARENT_NODE_TYPE_LOOKUP: Partial<Record<WikistNodeType, true>> = Object.assign(
  Object.create(null),
  {
    root: true,
    heading: true,
    paragraph: true,
    preformatted: true,
    list: true,
    'list-item': true,
    'definition-list': true,
    'definition-term': true,
    'definition-description': true,
    table: true,
    'table-caption': true,
    'table-row': true,
    'table-cell': true,
    bold: true,
    italic: true,
    'bold-italic': true,
    wikilink: true,
    'external-link': true,
    'image-link': true,
    template: true,
    'template-argument': true,
    'parser-function': true,
    'html-tag': true,
    redirect: true,
    gallery: true,
    reference: true,
  },
);

const LITERAL_VALUE_NODE_LOOKUP: Partial<Record<WikistNodeType, true>> = Object.assign(
  Object.create(null),
  {
    'html-entity': true,
    nowiki: true,
    comment: true,
  },
);

/**
 * Parse-time diagnostic enriched with tree-location metadata.
 *
 * The parser already reports recovery points as `error` events. The problem
 * for tree-only consumers is that those events disappear once `buildTree()`
 * materializes the AST.
 *
 * `anchor` fixes that gap. Today the anchor is intentionally narrow: it stores
 * one root-relative tree path to the nearest node active when the diagnostic
 * was recorded.
 *
 * ```text
 * root
 * ├─ paragraph        path [0]
 * │  └─ bold          path [0, 0]
 * └─ table            path [1]
 * ```
 *
 * Tools can walk `tree.children[path[0]].children[path[1]]...` to recover the
 * closest concrete node around the recovery point.
 *
 * The public API stops there on purpose. Session-backed edit-stable anchors,
 * slot identities, and other long-lived anchor semantics depend on later edit
 * tracking work, so they stay out of `ParseDiagnostic` for now.
 */
export interface ParseDiagnosticAnchor {
  /** Current anchor kind for diagnostics resolved against one final tree. */
  readonly kind: 'tree-path';
  /** Child-index path from the root to the nearest active node. */
  readonly path: readonly number[];
  /** Node type at `path`, or `'root'` when only the document is known. */
  readonly node_type: WikistNodeType;
}

/**
 * Recovery diagnostic preserved alongside the parsed tree.
 *
 * `anchor` is the location contract callers should use. It is tree-oriented
 * today, which means it resolves against the final materialized tree only. It
 * does not promise edit stability across later session changes yet.
 */
export interface ParseDiagnostic {
  /** Human-readable description of what was recovered from. */
  readonly message: string;
  /** Severity copied from the original diagnostic event when available. */
  readonly severity?: DiagnosticSeverity;
  /**
   * Stable machine-readable code for filtering and telemetry.
   *
   * Match on this field when building editor hints, quick fixes, or metrics.
   * The human-readable `message` is still useful for logs and UI, but the code
   * is the stable contract.
   */
  readonly code?: KnownDiagnosticCode | string;
  /** Whether recovery continued with a deterministic fallback. */
  readonly recoverable?: boolean;
  /** Parser stage that emitted the diagnostic. */
  readonly source?: 'tokenizer' | 'block' | 'inline' | 'tree';
  /** Optional structured metadata payload. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Source position where the diagnostic was detected. */
  readonly position: Position;
  /** Narrow location anchor for resolving the nearest node in the final tree. */
  readonly anchor: ParseDiagnosticAnchor;
}

/**
 * Tree plus recovery diagnostics.
 *
 * The exact tree shape depends on which materialization policy produced it.
 * `buildTreeWithDiagnostics()` returns the default HTML-like tree, while
 * `buildTreeStrict()` returns the conservative source-strict tree.
 */
export interface ParseDiagnosticsResult {
  /** Materialized wikist tree. */
  readonly tree: WikistRoot;
  /** Diagnostics collected while consuming the event stream. */
  readonly diagnostics: readonly ParseDiagnostic[];
}

/**
 * Recovery-aware tree result.
 *
 * This is the default diagnostics lane plus a boolean summary so a caller can
 * branch on recovery explicitly without rechecking the diagnostics array
 * length itself.
 */
export interface ParseResult extends ParseDiagnosticsResult {
  /** Whether any recovery diagnostics were recorded while producing this tree. */
  readonly recovered: boolean;
}

/**
 * Materialize a wikist tree from an event iterable.
 *
 * The event stream produced by `events()` already contains `enter('root')`
 * and `exit('root')`. The tree builder treats those as document boundary
 * markers, not as a nested root child node.
 *
 * ```text
 * incoming events (simplified)
 *   enter(root)
 *   enter(paragraph)
 *   text(...)
 *   exit(paragraph)
 *   exit(root)
 *
 * resulting tree
 *   root
 *   └─ paragraph
 *      └─ text
 * ```
 *
 * Recovery model for malformed streams:
 *
 * - `token` and `error` events are ignored for AST shape.
 * - a mismatched exit closes frames until the matching node is found.
 * - EOF with open frames auto-closes those frames using their last known end.
 *
 * This function never throws on malformed event streams. If the stream ends
 * with still-open nodes, it closes them using their last known end position so
 * callers still get a usable tree.
 */
export function buildTree(
  events: Iterable<WikitextEvent>,
  options: BuildTreeOptions,
): WikistRoot {
  return materializeTree(events, options, TreeMaterializationPolicy.DEFAULT_HTML_LIKE).tree;
}

/**
 * Materialize the default tolerant wikist tree and keep diagnostics alongside it.
 *
 * This is the diagnostics-first tree-building path for callers that want the
 * same HTML-like default tree shape as {@linkcode buildTree}, plus the
 * diagnostics that explain where malformed input was detected.
 *
 * The returned diagnostics include both event-layer findings preserved from
 * earlier parser stages and tree-builder-local findings such as mismatched
 * exits or EOF auto-closes.
 */
export function buildTreeWithDiagnostics(
  events: Iterable<WikitextEvent>,
  options: BuildTreeOptions,
): ParseDiagnosticsResult {
  return materializeDiagnosticsTree(events, options, TreeMaterializationPolicy.DEFAULT_HTML_LIKE);
}

/**
 * Materialize a conservative wikist tree and keep diagnostics alongside it.
 *
 * Use this when a caller wants diagnostics, but does not want recovery-heavy
 * wrappers to survive in the final tree unless the source clearly committed to
 * them.
 */
export function buildTreeStrict(
  events: Iterable<WikitextEvent>,
  options: BuildTreeOptions,
): ParseDiagnosticsResult {
  return materializeDiagnosticsTree(events, options, TreeMaterializationPolicy.SOURCE_STRICT);
}

/**
 * Materialize a wikist tree and make recovery explicit in the result shape.
 *
 * This uses the same diagnostics-preserving tree walk as
 * {@linkcode buildTreeWithDiagnostics}, but it also reports whether any
 * recovery happened while producing that tree.
 */
export function buildTreeWithRecovery(
  events: Iterable<WikitextEvent>,
  options: BuildTreeOptions,
): ParseResult {
  return materializeTree(events, options, TreeMaterializationPolicy.DEFAULT_HTML_LIKE, []);
}

/**
 * Create one in-progress node frame from an enter event.
 *
 * This captures the opening metadata once so later exit handling only needs to
 * decide where the node ends and how children should be attached.
 */
function createFrame(event: Extract<WikitextEvent, { kind: 'enter' }>): NodeFrame {
  return {
    kind: 'node',
    node_type: event.node_type as Exclude<WikistNodeType, 'root' | 'text'>,
    props: event.props,
    start: event.position.start,
    default_end: event.position.end,
    accepts_children: acceptsChildren(event.node_type as WikistNodeType),
    children: [],
    recover_as_text: false,
  };
}

/**
 * Close frames until `node_type` is found or the stack reaches the root frame.
 *
 * This is the main malformed-stream recovery hook. If exits arrive out of
 * order, we still produce a usable tree by finalizing intermediate frames at
 * the reported end point.
 */
function closeFrame(
  stack: TreeFrame[],
  node_type: string,
  end: Point,
  source: TextSource,
  materialization_policy: TreeMaterializationPolicy,
  diagnostics?: ParseDiagnostic[],
): void {
  while (stack.length > 1) {
    const top = stack[stack.length - 1];
    if (top === undefined || top.kind === 'root') return;

    if (top.node_type !== node_type && diagnostics !== undefined) {
      if (materialization_policy === TreeMaterializationPolicy.SOURCE_STRICT) {
        top.recover_as_text = true;
      }
      diagnostics.push(mismatchedExitDiagnostic(stack, end, node_type, top.node_type));
    }

    const frame = stack.pop();
    if (frame === undefined || frame.kind === 'root') return;

    appendChild(stack, finalizeFrame(frame, end, source));
    if (frame.node_type === node_type) return;
  }

  if (diagnostics !== undefined) {
    diagnostics.push(orphanExitDiagnostic(stack, end, node_type));
  }
}

/**
 * Attach one finished child node to the nearest frame that accepts children.
 *
 * The walk is from top of stack toward root, so nested nodes are attached to
 * the closest still-open parent first.
 */
function appendChild(stack: TreeFrame[], node: WikistNode): void {
  for (let index = stack.length - 1; index >= 0; index--) {
    const frame = stack[index];
    if (frame.kind === 'root' || frame.accepts_children) {
      frame.children.push(node);
      return;
    }
  }
}

/**
 * Convert an in-progress frame into a concrete wikist node.
 *
 * Parent-like node types receive `children`; literal node types receive a
 * string `value`; remaining node types are materialized as void-style objects
 * with props and position only.
 */
function finalizeFrame(frame: NodeFrame, end: Point, source: TextSource): WikistNode {
  const position: Position = {
    start: frame.start,
    end,
  };

  if (frame.recover_as_text) {
    return {
      type: 'text',
      value: slice(source, frame.start.offset, end.offset),
      position,
    };
  }

  if (frame.accepts_children) {
    return Object.assign(
      {
        type: frame.node_type,
        children: frame.children,
        position,
      },
      frame.props,
    ) as WikistNode;
  }

  if (isLiteralValueNode(frame.node_type)) {
    return {
      type: frame.node_type,
      value: readStringProp(frame.props, 'value'),
      position,
    } as WikistNode;
  }

  return Object.assign(
    {
      type: frame.node_type,
      position,
    },
    frame.props,
  ) as WikistNode;
}

/**
 * Finalize the top-level root node.
 *
 * Priority order for root position:
 *
 * 1. explicit `enter('root')` / `exit('root')` points from the stream
 * 2. fallback to first/last child positions when explicit root boundaries are
 *    absent
 * 3. omit `position` for empty roots with no explicit boundaries
 */
function finalizeRoot(root: RootFrame): WikistRoot {
  if (root.start_point !== undefined && root.end_point !== undefined) {
    return {
      type: 'root',
      children: root.children,
      position: {
        start: root.start_point,
        end: root.end_point,
      },
    };
  }

  if (root.children.length === 0) {
    return { type: 'root', children: [] };
  }

  const first = root.children[0];
  const last = root.children[root.children.length - 1];

  if (first.position === undefined || last.position === undefined) {
    return { type: 'root', children: root.children };
  }

  return {
    type: 'root',
    children: root.children,
    position: {
      start: first.position.start,
      end: last.position.end,
    },
  };
}

/** Read a string property from enter-event props with a safe empty fallback. */
function readStringProp(
  props: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = props[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Build the tree once and optionally capture diagnostics during the same walk.
 *
 * Keeping the shared traversal here ensures `buildTree()`,
 * `buildTreeWithDiagnostics()`, `buildTreeStrict()`, and
 * `buildTreeWithRecovery()` stay structurally identical apart from their final
 * materialization policy. The diagnostics path only pays extra work when a
 * collector array is provided.
 */
function materializeTree(
  events: Iterable<WikitextEvent>,
  options: BuildTreeOptions,
  materialization_policy: TreeMaterializationPolicy,
  diagnostics?: ParseDiagnostic[],
): ParseResult {
  const root: RootFrame = { kind: 'root', children: [] };
  const stack: TreeFrame[] = [root];

  for (const event of events) {
    switch (event.kind) {
      case 'enter':
        if (event.node_type === 'root') {
          root.start_point = event.position.start;
          root.end_point = event.position.end;
          break;
        }
        stack.push(createFrame(event));
        break;

      case 'exit':
        if (event.node_type === 'root') {
          root.end_point = event.position.end;
          break;
        }
        closeFrame(
          stack,
          event.node_type,
          event.position.end,
          options.source,
          materialization_policy,
          diagnostics,
        );
        break;

      case 'text':
        appendChild(stack, {
          type: 'text',
          value: slice(options.source, event.start_offset, event.end_offset),
          position: event.position,
        });
        break;

      case 'error':
        if (diagnostics !== undefined) {
          if (materialization_policy === TreeMaterializationPolicy.SOURCE_STRICT) {
            markCurrentFrameForSourceStrictText(stack, event.code);
          }
          diagnostics.push(parseDiagnosticFromEvent(event, stack));
        }
        break;

      case 'token':
        break;
    }
  }

  while (stack.length > 1) {
    const top = stack[stack.length - 1];
    if (top === undefined || top.kind === 'root') break;

    if (diagnostics !== undefined) {
      if (materialization_policy === TreeMaterializationPolicy.SOURCE_STRICT) {
        top.recover_as_text = true;
      }
      diagnostics.push(eofAutocloseDiagnostic(stack, top.default_end, top.node_type));
    }

    const frame = stack.pop();
    if (frame === undefined || frame.kind === 'root') break;
    appendChild(stack, finalizeFrame(frame, frame.default_end, options.source));
  }

  return {
    tree: finalizeRoot(root),
    recovered: (diagnostics?.length ?? 0) > 0,
    diagnostics: diagnostics ?? [],
  };
}

function materializeDiagnosticsTree(
  events: Iterable<WikitextEvent>,
  options: BuildTreeOptions,
  materialization_policy: TreeMaterializationPolicy,
): ParseDiagnosticsResult {
  const result = materializeTree(events, options, materialization_policy, []);

  if (materialization_policy !== TreeMaterializationPolicy.SOURCE_STRICT) {
    return {
      tree: result.tree,
      diagnostics: result.diagnostics,
    };
  }

  const stripped_paths = strippedDiagnosticPaths(result.diagnostics);

  return stripped_paths.length === 0
    ? {
      tree: result.tree,
      diagnostics: result.diagnostics,
    }
    : {
      tree: result.tree,
      diagnostics: retargetDiagnostics(result.diagnostics, stripped_paths),
    };
}

function strippedDiagnosticPaths(
  diagnostics: readonly ParseDiagnostic[],
): readonly (readonly number[])[] {
  const raw_paths = diagnostics
    .flatMap((diagnostic) => {
      if (diagnostic.anchor.kind !== 'tree-path') return [];
      if (diagnostic.anchor.path.length === 0) return [];
      if (!shouldStripRecoveredNode(diagnostic.code)) return [];
      return [Array.from(diagnostic.anchor.path)];
    })
    .sort(compareTreePaths);

  const filtered_paths: number[][] = [];
  for (const path of raw_paths) {
    if (filtered_paths.some((selected_path) => isTreePathPrefix(selected_path, path))) {
      continue;
    }
    filtered_paths.push(path);
  }

  return filtered_paths;
}

function shouldStripRecoveredNode(code?: KnownDiagnosticCode | string): boolean {
  switch (code) {
    case DiagnosticCode.UNCLOSED_TABLE:
    case DiagnosticCode.INLINE_TAG_MISSING_CLOSE:
    case DiagnosticCode.TREE_MISMATCHED_EXIT:
    case DiagnosticCode.TREE_EOF_AUTOCLOSE:
      return true;

    default:
      return false;
  }
}

function compareTreePaths(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }

  for (let index = 0; index < left.length; index++) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }

  return 0;
}

function isTreePathPrefix(prefix: readonly number[], path: readonly number[]): boolean {
  if (prefix.length > path.length) return false;

  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] !== path[index]) return false;
  }

  return true;
}

function retargetDiagnostics(
  diagnostics: readonly ParseDiagnostic[],
  stripped_paths: readonly (readonly number[])[],
): readonly ParseDiagnostic[] {
  let changed = false;
  const next_diagnostics = diagnostics.map((diagnostic) => {
    const next_anchor = retargetDiagnosticAnchor(diagnostic.anchor, stripped_paths);
    if (next_anchor === diagnostic.anchor) {
      return diagnostic;
    }

    changed = true;
    return Object.assign({}, diagnostic, { anchor: next_anchor });
  });

  return changed ? next_diagnostics : diagnostics;
}

function retargetDiagnosticAnchor(
  anchor: ParseDiagnosticAnchor,
  stripped_paths: readonly (readonly number[])[],
): ParseDiagnosticAnchor {
  if (anchor.kind !== 'tree-path') {
    return anchor;
  }

  const replacement_path = nearestStrippedAncestorPath(anchor.path, stripped_paths);
  if (replacement_path === undefined) {
    return anchor;
  }

  return {
    kind: 'tree-path',
    path: Array.from(replacement_path),
    node_type: 'text',
  };
}

function nearestStrippedAncestorPath(
  path: readonly number[],
  stripped_paths: readonly (readonly number[])[],
): readonly number[] | undefined {
  let nearest_path: readonly number[] | undefined;

  for (const stripped_path of stripped_paths) {
    if (!isTreePathPrefix(stripped_path, path)) {
      continue;
    }

    if (nearest_path === undefined || stripped_path.length > nearest_path.length) {
      nearest_path = stripped_path;
    }
  }

  return nearest_path;
}

function markCurrentFrameForSourceStrictText(
  stack: TreeFrame[],
  code?: KnownDiagnosticCode | string,
): void {
  if (!shouldStripRecoveredNode(code)) {
    return;
  }

  const top = stack[stack.length - 1];
  if (top !== undefined && top.kind === 'node') {
    top.recover_as_text = true;
  }
}

/**
 * Classify node types that own child nodes.
 *
 * A null-prototype lookup table is a better fit here than `Set` because this
 * is a fixed string vocabulary, not a dynamic runtime collection. The lookup
 * data stays in one auditable place, `Object.create(null)` removes inherited
 * prototype keys, and `Object.hasOwn(...)` keeps the membership check on the
 * table's own entries instead of walking the prototype chain.
 */
function acceptsChildren(node_type: WikistNodeType): boolean {
  return Object.hasOwn(PARENT_NODE_TYPE_LOOKUP, node_type);
}

/**
 * Return whether a node stores its payload in a `value` field.
 *
 * These nodes are still represented in the tree, but they do not have child
 * nodes. Their content is copied from enter-event props during finalization.
 */
function isLiteralValueNode(node_type: WikistNodeType): boolean {
  return Object.hasOwn(LITERAL_VALUE_NODE_LOOKUP, node_type);
}

/**
 * Turn an event-layer `error` event into a tree-oriented diagnostic.
 *
 * This path preserves parser-stage diagnostics exactly as they were emitted,
 * then adds tree-local location metadata. A block or inline parser can report
 * the recovery in its own words, and the tree builder adds a narrow tree
 * anchor so the consumer can still find the relevant region after tree
 * materialization without exposing future edit-stable anchor semantics early.
 */
function parseDiagnosticFromEvent(
  event: ErrorEvent,
  stack: TreeFrame[],
): ParseDiagnostic {
  const anchor = currentDiagnosticAnchor(stack);

  return {
    message: event.message,
    severity: event.severity,
    code: event.code,
    recoverable: event.recoverable,
    source: event.source,
    details: event.details,
    position: event.position,
    anchor,
  };
}

/**
 * Report that the tree builder had to auto-close an inner node before it could
 * honor the requested exit event.
 *
 * Example malformed event order:
 *
 * ```text
 * enter(paragraph)
 * enter(bold)
 * exit(paragraph)
 * ```
 *
 * The builder closes `bold` first, then closes `paragraph`, so the final tree
 * stays well-formed.
 *
 * Consumers might respond by:
 *
 * - surfacing a warning near the recovered node
 * - offering a fix that restores the missing closer for the inner node
 * - ignoring it in tolerant rendering where the recovered shape is enough
 */
function mismatchedExitDiagnostic(
  stack: TreeFrame[],
  point: Point,
  expected_node_type: string,
  recovered_node_type: string,
): ParseDiagnostic {
  return treeRecoveryDiagnostic(
    stack,
    point,
    `Auto-closed ${recovered_node_type} while recovering from exit(${expected_node_type}).`,
    DiagnosticCode.TREE_MISMATCHED_EXIT,
    {
      expected_node_type,
      recovered_node_type,
    },
  );
}

/**
 * Report that the tree builder saw an exit event that no longer matched any
 * open frame.
 *
 * Example malformed event order:
 *
 * ```text
 * exit(italic)
 * ```
 *
 * at a point where the stack already returned to the root.
 *
 * Consumers can treat this as a structural warning, log it for parser
 * debugging, or ignore it if only the recovered tree matters.
 */
function orphanExitDiagnostic(
  stack: TreeFrame[],
  point: Point,
  expected_node_type: string,
): ParseDiagnostic {
  return treeRecoveryDiagnostic(
    stack,
    point,
    `Dropped unmatched exit(${expected_node_type}) at the root boundary.`,
    DiagnosticCode.TREE_ORPHAN_EXIT,
    { expected_node_type },
  );
}

/**
 * Report that the event stream ended while a node was still open.
 *
 * Example malformed event order:
 *
 * ```text
 * enter(paragraph)
 * text(...)
 * EOF
 * ```
 *
 * The builder closes the node at its last known end point so the final tree is
 * still usable.
 *
 * Consumers may show a warning, offer a fix for the missing closer, or simply
 * continue with the recovered tree when best-effort output is acceptable.
 */
function eofAutocloseDiagnostic(
  stack: TreeFrame[],
  point: Point,
  recovered_node_type: string,
): ParseDiagnostic {
  return treeRecoveryDiagnostic(
    stack,
    point,
    `Auto-closed ${recovered_node_type} at end of event stream.`,
    DiagnosticCode.TREE_EOF_AUTOCLOSE,
    { recovered_node_type },
  );
}

/**
 * Build a tree-stage recovery diagnostic at a zero-width point.
 *
 * This helper is intentionally small: the detailed, situation-specific TSDoc
 * lives on the wrapper helpers for each recovery code so maintainers can read
 * the exact failure mode where it is emitted.
 */
function treeRecoveryDiagnostic(
  stack: TreeFrame[],
  point: Point,
  message: string,
  code: KnownDiagnosticCode,
  details: Readonly<Record<string, unknown>>,
): ParseDiagnostic {
  const anchor = currentDiagnosticAnchor(stack);
  const position = pointPosition(point);

  return {
    message,
    severity: 'warning',
    code,
    recoverable: true,
    source: 'tree',
    details,
    position,
    anchor,
  };
}

/**
 * Resolve the current narrow diagnostic anchor from the builder stack.
 *
 * Open frames are not attached to their parents until they close, so the path
 * uses the current child counts as the future insertion index for each open
 * frame. That gives downstream tools a stable route to the closest node once
 * the final tree has been materialized.
 */
function currentDiagnosticAnchor(
  stack: TreeFrame[],
): ParseDiagnosticAnchor {
  const path: number[] = [];

  if (stack.length === 1) {
    return { kind: 'tree-path', path, node_type: 'root' };
  }

  for (let index = 1; index < stack.length; index++) {
    const parent = stack[index - 1];
    if (parent.kind === 'root' || parent.accepts_children) {
      path.push(parent.children.length);
    }
  }

  const top = stack[stack.length - 1];
  return {
    kind: 'tree-path',
    path,
    node_type: top.kind === 'root' ? 'root' : top.node_type,
  };
}

/** Build a zero-width position at one point. */
function pointPosition(point: Point): Position {
  return { start: point, end: point };
}