# Examples

These examples show the most common ways to use the parser without reading the
deeper architecture notes first.

They start with the simplest paths and then move toward more inspection-heavy
flows.

## Build a tree for normal document work

Use `parse()` when you want a tree and you do not need diagnostics.

```ts
import { parse } from '@okikio/wikitext';

const tree = parse('== Heading ==\n\nA paragraph with [[Main Page|a link]].');
console.log(tree.type); // 'root'
```

This is the cheapest tree path. It is a good fit when the source is mostly
ordinary wikitext and you do not need the parser's explanation of malformed
regions.

## Inspect headings without building a tree

Use `outlineEvents()` when you only care about block structure such as headings
or lists.

```ts
import { outlineEvents } from '@okikio/wikitext';

const headings = [];

for (const event of outlineEvents('== One ==\n\nText\n\n=== Two ===')) {
  if (event.kind === 'enter' && event.node_type === 'heading') {
    headings.push(event);
  }
}
```

## Keep diagnostics while preserving the default tree

Use `parseWithDiagnostics()` when you want the parser's default tolerant tree
and also want to know where malformed input was detected.

```ts
import { parseWithDiagnostics } from '@okikio/wikitext';

const result = parseWithDiagnostics('Paragraph with <ref name="x">note');

console.log(result.tree.children[0]?.type);
console.log(result.diagnostics.map((diagnostic) => diagnostic.code));
```

This is the best current fit for the "recover on my behalf, but tell me what
you did" style of usage.

## Keep the same default tree but branch on recovery explicitly

Use `parseWithRecovery()` when you want the same default tree and diagnostics
as `parseWithDiagnostics()`, but you also want a cheap boolean for control
flow.

```ts
import { parseWithRecovery } from '@okikio/wikitext';

const result = parseWithRecovery('Paragraph with <ref name="x">note');

if (result.recovered) {
  console.log(result.diagnostics.map((diagnostic) => diagnostic.code));
}
```

This is useful when your tool wants the parser's default tolerant tree but does
not want to re-derive recovery status from `diagnostics.length > 0` each time.

## Ask for the conservative tree instead

Use `parseStrictWithDiagnostics()` when diagnostics matter and you want the final tree to be
more conservative about malformed committed structure.

```ts
import { parseStrictWithDiagnostics } from '@okikio/wikitext';

const result = parseStrictWithDiagnostics('Paragraph with <ref name="x">note');

console.log(result.tree.children[0]?.type);
console.log(result.diagnostics.length > 0);
```

This is useful for inspection or linting flows that do not want the final tree
to keep as much repaired structure.

## Analyze once, materialize many

Use `analyze()` + `materialize()` when you want to inspect parser findings
before deciding how (or whether) to build a tree, or when you want to build
more than one tree from the same parse.

```ts
import { analyze, materialize, TreeMaterializationPolicy } from '@okikio/wikitext';

const findings = analyze('Paragraph with <ref name="cite-1">note');

// Inspect without materializing a tree.
for (const entry of findings.recovery ?? []) {
  console.log(entry.kind, entry.code, entry.policies);
}

// Build the default tree once.
const tolerant = materialize(findings);

// Build a conservative tree from the same findings without reparsing.
const strict = materialize(findings, {
  policy: TreeMaterializationPolicy.SOURCE_STRICT,
});

console.log(tolerant.tree.children[0]?.type); // 'paragraph'
console.log(strict.tree.children[0]?.type);   // 'paragraph' with text-only children
```

The `findings.recovery` array lists the parser's structural decisions with a
narrow taxonomy (`missing-close`, `unterminated-opener`, `unclosed-table`,
`mismatched-exit`, `orphan-exit`, `eof-autoclose`). Each entry also lists the
materialization policies that can change the final shape, so tooling can
decide when policy choice is meaningful.

## Skip the recovery list when you only want events

Pass `{ recovery: false }` to `analyze()` to drop the recovery derivation when
you only care about events and diagnostics.

```ts
import { analyze } from '@okikio/wikitext';

const findings = analyze('{|\n| Cell', { recovery: false });

console.log(findings.diagnostics.length > 0);
console.log(findings.recovery); // undefined
```

## Compare the current tree lanes on one malformed input

The easiest way to understand the tree differences is to run the same input
through more than one lane.

```ts
import {
  parse,
  parseStrictWithDiagnostics,
  parseWithDiagnostics,
  parseWithRecovery,
} from '@okikio/wikitext';

const input = 'Paragraph with <ref name="x">note';

const default_tree = parse(input);
const default_diagnostics = parseWithDiagnostics(input);
const default_recovery = parseWithRecovery(input);
const conservative_tree = parseStrictWithDiagnostics(input);

console.log(default_tree.children[0]?.type);
console.log(default_diagnostics.tree.children[0]?.type);
console.log(default_recovery.recovered);
console.log(conservative_tree.tree.children[0]?.type);
console.log(default_diagnostics.diagnostics.map((diagnostic) => diagnostic.code));
```

This kind of comparison is useful when you are deciding whether your tool wants
the cheapest default tree, the default tree with diagnostics, the same default
tree with an explicit recovery summary, or the conservative source-strict tree.

## Resolve a diagnostic back to the tree

Diagnostics live beside the tree, but you can still resolve them back to the
nearest materialized node.

```ts
import { locateDiagnostic, parseWithDiagnostics } from '@okikio/wikitext';

const result = parseWithDiagnostics('{|\n| Cell');
const location = locateDiagnostic(result.tree, result.diagnostics[0]);

console.log(location?.node.type);
console.log(location?.parent?.type);
console.log(location?.index);
```

This is useful for editor tooling, lint output, or any workflow that wants to
connect a parser finding back to a concrete part of the final tree.

## Reuse one source through a session

Use a session when you want to ask more than one question about the same input.

```ts
import { createSession } from '@okikio/wikitext';

const session = createSession('== Heading ==\n\nParagraph with [[Main Page]].');

const outline = Array.from(session.outline());
const full_events = Array.from(session.events());
const tree = session.parse();

console.log(outline.length > 0);
console.log(full_events.length > 0);
console.log(tree.type);
```

This avoids redoing the same work from scratch each time you ask a different
question about one source string.

## Build a focused parser on top of events

This package is utility-first. If you need domain-specific behavior, prefer
building on the public primitives instead of expecting deep hooks in the core
parser.

```ts
import { events } from '@okikio/wikitext';

function collectLinks(source: string): string[] {
  const links: string[] = [];

  for (const event of events(source)) {
    if (event.kind === 'enter' && event.node_type === 'wikilink') {
      links.push(String(event.props.target));
    }
  }

  return links;
}

console.log(collectLinks('Visit [[Main Page]] and [[Help:Contents]].'));
```

If you want the reasoning behind that design, see
[docs/architecture/utility-first.md](./architecture/utility-first.md).