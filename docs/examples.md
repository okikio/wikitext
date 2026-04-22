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

## Compare the current tree lanes on one malformed input

The easiest way to understand the tree differences is to run the same input
through more than one lane.

```ts
import { parse, parseStrictWithDiagnostics, parseWithDiagnostics } from '@okikio/wikitext';

const input = 'Paragraph with <ref name="x">note';

const fast_tree = parse(input);
const recovery_tree = parseWithDiagnostics(input);
const conservative_tree = parseStrictWithDiagnostics(input);

console.log(fast_tree.children[0]?.type);
console.log(recovery_tree.tree.children[0]?.type);
console.log(conservative_tree.tree.children[0]?.type);
console.log(recovery_tree.diagnostics.map((diagnostic) => diagnostic.code));
```

This kind of comparison is useful when you are deciding whether your tool wants
speed first, tolerant structure first, or conservative diagnostics first.

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