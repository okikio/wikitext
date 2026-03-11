/**
 * Tree and event filtering helpers.
 *
 * The parser's event stream is already useful on its own, but many consumers
 * still want small convenience helpers for common tree queries such as "find
 * every template" or "walk every node in document order".
 *
 * This module keeps those helpers deliberately small and predictable. Nothing
 * here changes parser behavior. These are consumer utilities built on top of
 * the core data shapes.
 *
 * @example Collecting all templates from a tree
 * ```ts
 * import { filterTemplates } from './filter.ts';
 * import { parse } from './parse.ts';
 *
 * const tree = parse('{{Infobox|name=value}}');
 * const templates = filterTemplates(tree);
 * ```
 *
 * @module
 */

import type {
  Argument,
  BehaviorSwitch,
  CategoryLink,
  ExternalLink,
  ImageLink,
  List,
  MagicWord,
  ParserFunction,
  Reference,
  Redirect,
  Table,
  Template,
  Wikilink,
  WikistNode,
  WikistNodeType,
  WikistParent,
  WikistRoot,
} from './ast.ts';
import type { WikitextEvent } from './events.ts';
import type { ParseDiagnostic, ParseDiagnosticAnchor } from './tree_builder.ts';

import { isParent } from './ast.ts';

/**
 * Context passed to a tree visitor.
 */
export interface VisitContext {
  /** Parent node that owns the visited node, if one exists. */
  readonly parent?: WikistParent;
  /** Child index inside the parent, if one exists. */
  readonly index?: number;
}

/**
 * Callback shape used by {@linkcode visit}.
 */
export type VisitHandler = (node: WikistNode, context: VisitContext) => void;

/**
 * Resolved location of a node reached through a tree path.
 */
export interface TreePathResolution {
  /** Node reached by following the path. */
  readonly node: WikistNode;
  /** Parent that owns the resolved node, when one exists. */
  readonly parent?: WikistParent;
  /** Child index inside the parent, when one exists. */
  readonly index?: number;
}

type MatchableNode =
  | Argument
  | BehaviorSwitch
  | CategoryLink
  | ImageLink
  | MagicWord
  | ParserFunction
  | Redirect
  | Template
  | Wikilink;

/**
 * Fixed mapping from node type to the field used by `matches()`.
 *
 * Some nodes expose their user-visible identity through `name`, others through
 * `target`. Centralizing that distinction here keeps the comparison logic
 * simple and avoids repeating a large switch in the hot path.
 */
const MATCH_NAME_FIELD_LOOKUP: Partial<Record<MatchableNode['type'], 'name' | 'target'>> = Object.assign(
  Object.create(null),
  {
    template: 'name',
    'parser-function': 'name',
    'magic-word': 'name',
    'behavior-switch': 'name',
    argument: 'name',
    wikilink: 'target',
    'image-link': 'target',
    'category-link': 'target',
    redirect: 'target',
  },
);

/**
 * Visit every node in pre-order depth-first order.
 *
 * The visitor runs on the current node before its children. That matches the
 * usual "walk the tree top-down" mental model used by most syntax-tree tools.
 */
export function visit(node: WikistNode, visitor: VisitHandler): void {
  walk(node, visitor, undefined, undefined);
}

/**
 * Collect every node of a given type from a tree.
 *
 * This is the simplest recursive query helper in the module. It intentionally
 * walks the public tree shape instead of relying on internal parser details, so
 * it stays useful for both parsed trees and trees built by hand in tests or
 * downstream tooling.
 */
export function filter<Type extends WikistNodeType>(
  tree: WikistNode,
  type: Type,
): Extract<WikistNode, { type: Type }>[] {
  const matches: Extract<WikistNode, { type: Type }>[] = [];

  visit(tree, (node) => {
    if (node.type === type) {
      matches.push(node as Extract<WikistNode, { type: Type }>);
    }
  });

  return matches;
}

/**
 * Collect all template nodes.
 */
export function filterTemplates(tree: WikistNode): Template[] {
  return filter(tree, 'template');
}

/**
 * Collect visible link nodes.
 *
 * This includes wiki links, external links, and redirects. Image embeds and
 * category assignments have their own dedicated helpers.
 */
export function filterLinks(
  tree: WikistNode,
): Array<Wikilink | ExternalLink | Redirect> {
  return [
    ...filter(tree, 'wikilink'),
    ...filter(tree, 'external-link'),
    ...filter(tree, 'redirect'),
  ];
}

/**
 * Collect all image-link nodes.
 */
export function filterImages(tree: WikistNode): ImageLink[] {
  return filter(tree, 'image-link');
}

/**
 * Collect all list nodes.
 */
export function filterLists(tree: WikistNode): List[] {
  return filter(tree, 'list');
}

/**
 * Collect all table nodes.
 */
export function filterTables(tree: WikistNode): Table[] {
  return filter(tree, 'table');
}

/**
 * Collect all category-link nodes.
 */
export function filterCategories(tree: WikistNode): CategoryLink[] {
  return filter(tree, 'category-link');
}

/**
 * Collect all reference nodes.
 */
export function filterReferences(tree: WikistNode): Reference[] {
  return filter(tree, 'reference');
}

/**
 * Compare a node name or target against a candidate string.
 *
 * The normalization is intentionally conservative: trim outer whitespace,
 * treat underscores like spaces, collapse repeated spaces, and compare
 * case-insensitively. That makes common wiki-name matching less fragile
 * without claiming full MediaWiki title normalization.
 */
export function matches(node: MatchableNode, name: string): boolean {
  return normalizeName(readMatchName(node)) === normalizeName(name);
}

/**
 * Lazily filter an event iterable.
 *
 * This is the event-stream counterpart to `filter()`. It preserves laziness so
 * callers can keep streaming large event sources instead of materializing the
 * whole stream up front.
 */
export function* filterEvents(
  events: Iterable<WikitextEvent>,
  predicate: (event: WikitextEvent) => boolean,
): Generator<WikitextEvent> {
  for (const event of events) {
    if (predicate(event)) {
      yield event;
    }
  }
}

/**
 * Collect the full event slices for every subtree of a given node type.
 *
 * Each returned array starts with the matching `enter` event and ends with the
 * matching `exit` event. Nested matches are preserved as separate arrays.
 *
 * The algorithm keeps a small stack of active matching groups. Every incoming
 * event is appended to all currently open groups, and a new group starts when
 * a matching `enter` appears.
 *
 * Example for collecting `wikilink` slices:
 *
 * ```text
 * enter(paragraph)
 * text("A ")
 * enter(wikilink)   -> start new group
 * text("Mars")      -> appended to that group
 * exit(wikilink)    -> close and store that group
 * ```
 */
export function collectEvents(
  events: Iterable<WikitextEvent>,
  node_type: string,
): WikitextEvent[][] {
  const active: WikitextEvent[][] = [];
  const result: WikitextEvent[][] = [];

  for (const event of events) {
    if (event.kind === 'enter' && event.node_type === node_type) {
      for (const group of active) {
        group.push(event);
      }
      active.push([event]);
      continue;
    }

    for (const group of active) {
      group.push(event);
    }

    if (event.kind === 'exit' && event.node_type === node_type && active.length > 0) {
      const group = active.pop();
      if (group !== undefined) {
        result.push(group);
      }
    }
  }

  return result;
}

/**
 * Resolve a root-relative child-index path into a concrete node location.
 *
 * This helper is the low-level building block behind tree-path diagnostic
 * anchors. Diagnostics preserve the path while the tree is being built, and
 * higher-level helpers can turn that path back into a real node reference plus
 * parent/index context.
 *
 * ```text
 * root
 * ├─ paragraph        path [0]
 * │  └─ bold          path [0, 0]
 * └─ table            path [1]
 * ```
 *
 * If the path no longer matches the tree shape, the function returns
 * `undefined` instead of guessing.
 * That fail-closed behavior matters when callers hold onto a path longer than
 * the tree it came from, or accidentally resolve it against a different tree.
 */
export function resolveTreePath(
  tree: WikistRoot,
  tree_path: readonly number[],
): TreePathResolution | undefined {
  let current: WikistNode = tree;
  let parent: WikistParent | undefined;
  let index: number | undefined;

  if (tree_path.length === 0) {
    return { node: tree };
  }

  for (const child_index of tree_path) {
    if (!isParent(current)) return undefined;
    if (child_index < 0 || child_index >= current.children.length) {
      return undefined;
    }

    parent = current;
    index = child_index;
    current = current.children[child_index];
  }

  return {
    node: current,
    parent,
    index,
  };
}

/**
 * Resolve one diagnostic anchor to the nearest concrete node location.
 *
 * Diagnostics currently expose one narrow anchor kind: `tree-path`. It is a
 * snapshot of the nearest route through the final materialized tree. That is
 * enough for editor hints, inspections, and recovery UIs today without
 * promising edit-stable anchor behavior before session edit tracking exists.
 *
 * The helper returns `undefined` for stale anchors instead of guessing. That
 * matters when a caller accidentally resolves an anchor against a different
 * tree instance or after reshaping the tree.
 */
export function resolveDiagnosticAnchor(
  tree: WikistRoot,
  anchor: ParseDiagnosticAnchor,
): TreePathResolution | undefined {
  switch (anchor.kind) {
    case 'tree-path':
      return resolveTreePath(tree, anchor.path);
  }
}

/**
 * Resolve the nearest node location for one parse diagnostic.
 *
 * This is a convenience wrapper over {@linkcode resolveDiagnosticAnchor} so
 * callers do not need to manually thread `diagnostic.anchor` through every use
 * site.
 *
 * Today those diagnostics mostly come from block-parser recovery events and
 * tree-builder recovery steps. `parse()` intentionally drops them,
 * `parseWithDiagnostics()` preserves them for inspection, and
 * `parseWithRecovery()` adds an explicit boolean summary on top of the same
 * diagnostics.
 */
export function locateDiagnostic(
  tree: WikistRoot,
  diagnostic: ParseDiagnostic,
): TreePathResolution | undefined {
  return resolveDiagnosticAnchor(tree, diagnostic.anchor);
}

function walk(
  node: WikistNode,
  visitor: VisitHandler,
  parent: WikistParent | undefined,
  index: number | undefined,
): void {
  visitor(node, { parent, index });

  if (!isParent(node)) return;

  for (let child_index = 0; child_index < node.children.length; child_index++) {
    walk(node.children[child_index], visitor, node, child_index);
  }
}

function readMatchName(node: MatchableNode): string {
  return MATCH_NAME_FIELD_LOOKUP[node.type] === 'name'
    ? (node as Argument | BehaviorSwitch | MagicWord | ParserFunction | Template).name
    : (node as CategoryLink | ImageLink | Redirect | Wikilink).target;
}

function normalizeName(value: string): string {
  return value
    .trim()
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}