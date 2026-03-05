# Wikist Specification

Wikist (Wiki Syntax Tree) is a syntax tree format for wikitext markup. It
extends the [unist][] (Universal Syntax Tree) specification, following the
pattern established by [mdast][] (Markdown), [hast][] (HTML), and [xast][]
(XML).

This document defines the node types, their fields, and the tree structure
contracts.

[unist]: https://github.com/syntax-tree/unist
[mdast]: https://github.com/syntax-tree/mdast
[hast]: https://github.com/syntax-tree/hast
[xast]: https://github.com/syntax-tree/xast


## unist compatibility

Every wikist node satisfies the unist `Node` interface:

```ts
interface Node {
  type: string;
  position?: { start: Point; end: Point };
  data?: Record<string, unknown>;
}

interface Point {
  line: number;    // 1-indexed
  column: number;  // 1-indexed, UTF-16 code units
  offset: number;  // 0-indexed, UTF-16 code units
}
```

Parent nodes have `children: WikistNode[]`. Literal nodes have `value: string`.
The `type` field is a string discriminant for exhaustive pattern matching.

`data` is an optional bag for extension metadata (per unist spec). Data slots
are not used by the core parser but are available for consumers and extensions.


## Node categories

Three base categories, mirroring unist:

| Category | Fields | Description |
|----------|--------|-------------|
| Parent | `children: WikistNode[]` | Contains child nodes |
| Literal | `value: string` | Contains text content |
| Void | (neither) | No children, no value (marker nodes) |


## Node type table

| Node | Category | Parent type | Extra fields |
|------|----------|-------------|--------------|
| `Root` | Parent | (document root) | (none) |
| `Heading` | Parent | Root | `level: 1\|2\|3\|4\|5\|6` |
| `Paragraph` | Parent | Root, ListItem, TableCell, etc. | (none) |
| `ThematicBreak` | Void | Root | (none) |
| `Preformatted` | Parent | Root | (none) |
| `List` | Parent | Root, ListItem | `ordered: boolean` |
| `ListItem` | Parent | List | `marker: string` |
| `DefinitionList` | Parent | Root | (none) |
| `DefinitionTerm` | Parent | DefinitionList | (none) |
| `DefinitionDescription` | Parent | DefinitionList | (none) |
| `Table` | Parent | Root | `attributes?: string` |
| `TableCaption` | Parent | Table | (none) |
| `TableRow` | Parent | Table | `attributes?: string` |
| `TableCell` | Parent | TableRow | `header: boolean`, `attributes?: string` |
| `Bold` | Parent | (inline context) | (none) |
| `Italic` | Parent | (inline context) | (none) |
| `BoldItalic` | Parent | (inline context) | (none) |
| `Wikilink` | Parent | (inline context) | `target: string` |
| `ExternalLink` | Parent | (inline context) | `url: string` |
| `ImageLink` | Parent | (inline context) | `target: string` |
| `CategoryLink` | Parent | (inline context) | `target: string`, `sort_key?: string` |
| `Template` | Parent | (inline context) | `name: string` |
| `TemplateArgument` | Parent | Template | `name?: string` (named) or positional |
| `Argument` | Parent | (inline context) | `name: string`, `default?: string` |
| `ParserFunction` | Parent | (inline context) | `name: string` |
| `MagicWord` | Void | (inline context) | `name: string` |
| `BehaviorSwitch` | Void | (inline context) | `name: string` |
| `HtmlTag` | Parent | (inline context) | `tag_name: string`, `self_closing: boolean`, `attributes?: Record<string, string>` |
| `HtmlEntity` | Literal | (inline context) | (none) |
| `Text` | Literal | (any parent) | (none) |
| `Nowiki` | Literal | (inline context) | (none) |
| `Comment` | Literal | (any) | (none) |
| `Redirect` | Parent | Root | `target: string` |
| `Signature` | Void | (inline context) | `tildes: 3\|4\|5` |
| `Break` | Void | (inline context) | (none) |
| `Gallery` | Parent | Root | `attributes?: Record<string, string>` |
| `Reference` | Parent | (inline context) | `name?: string`, `group?: string` |
| `Conflict` | Parent | (any) | `variants: WikistNode[][]` **(reserved)** |


## Node definitions

### Root

The top-level node. Every parse result is a `Root`. Contains block-level
children.

```ts
interface Root {
  type: "root";
  children: WikistNode[];
}
```

### Heading

A section heading (`== Title ==`). Level corresponds to the number of `=`
markers (1-6).

```ts
interface Heading {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: WikistNode[];  // inline content
}
```

### Paragraph

A block of inline content separated by blank lines or other block elements.

```ts
interface Paragraph {
  type: "paragraph";
  children: WikistNode[];
}
```

### ThematicBreak

A horizontal rule (`----` or more dashes at line start).

```ts
interface ThematicBreak {
  type: "thematic-break";
}
```

### Preformatted

Lines starting with a space character. Rendered as `<pre>` in MediaWiki.

```ts
interface Preformatted {
  type: "preformatted";
  children: WikistNode[];
}
```

### List and ListItem

Bullet lists (`*`), ordered lists (`#`). Lists nest when markers are stacked
(`**` = nested bullet). Mixed markers (`*#`) create heterogeneous nesting.

```ts
interface List {
  type: "list";
  ordered: boolean;
  children: ListItem[];
}

interface ListItem {
  type: "list-item";
  marker: string;  // the raw marker characters, e.g. "**" or "#*"
  children: WikistNode[];
}
```

### DefinitionList, DefinitionTerm, DefinitionDescription

Definition lists use `;` for terms and `:` for descriptions.

```ts
interface DefinitionList {
  type: "definition-list";
  children: (DefinitionTerm | DefinitionDescription)[];
}

interface DefinitionTerm {
  type: "definition-term";
  children: WikistNode[];
}

interface DefinitionDescription {
  type: "definition-description";
  children: WikistNode[];
}
```

### Table, TableCaption, TableRow, TableCell

Full table structure. `{|` opens, `|}` closes, `|-` starts a row, `!` marks
header cells, `|` marks data cells, `|+` is the caption.

```ts
interface Table {
  type: "table";
  attributes?: string;  // raw attribute string from {| line
  children: (TableCaption | TableRow)[];
}

interface TableCaption {
  type: "table-caption";
  children: WikistNode[];
}

interface TableRow {
  type: "table-row";
  attributes?: string;
  children: TableCell[];
}

interface TableCell {
  type: "table-cell";
  header: boolean;  // true for ! cells, false for | cells
  attributes?: string;
  children: WikistNode[];
}
```

### Bold, Italic, BoldItalic

Inline formatting from apostrophe runs. `''italic''`, `'''bold'''`,
`'''''bold italic'''''`.

```ts
interface Bold {
  type: "bold";
  children: WikistNode[];
}

interface Italic {
  type: "italic";
  children: WikistNode[];
}

interface BoldItalic {
  type: "bold-italic";
  children: WikistNode[];
}
```

### Wikilink

Internal links: `[[Target]]` or `[[Target|display text]]`.

A leading colon in the target (`[[:Category:Foo]]`, `[[:File:Foo.png]]`)
produces a visible link instead of category assignment or image embed. The
parser checks for and strips the leading colon during namespace dispatch.

```ts
interface Wikilink {
  type: "wikilink";
  target: string;
  children: WikistNode[];  // display text (if any), otherwise target is used
}
```

**String field note**: `target` is a convenience field extracted from the source
range. It is lossy (e.g., comments or whitespace in the target are not
preserved). The authoritative source text is always recoverable from
`node.position` offsets into the input. Consumers needing exact source text
should slice the input using `position.start.offset` / `position.end.offset`.

### ExternalLink

External links: `[https://example.com text]` or bare URLs.

```ts
interface ExternalLink {
  type: "external-link";
  url: string;
  children: WikistNode[];  // display text
}
```

### ImageLink

Image embeds: `[[File:Example.png|thumb|Caption]]` or `[[Image:...]]`.

A leading colon (`[[:File:Foo.png]]`) produces a `Wikilink` instead of an
`ImageLink`: it becomes a visible link to the file page, not an image embed.

```ts
interface ImageLink {
  type: "image-link";
  target: string;  // filename including namespace
  children: WikistNode[];  // options and caption parts
}
```

### CategoryLink

Category tags: `[[Category:Name]]` or `[[Category:Name|sort key]]`.

A leading colon (`[[:Category:Foo]]`) produces a `Wikilink` instead of a
`CategoryLink`: it becomes a visible link to the category page, not a
category assignment.

```ts
interface CategoryLink {
  type: "category-link";
  target: string;
  sort_key?: string;
}
```

### Template and TemplateArgument

Template transclusion: `{{TemplateName|arg1|name=value}}`. Also the default
node type for `{{ }}` constructs that cannot be classified as parser functions
(which have a `#` prefix) without MediaWiki configuration. Variable-style magic
words (`{{PAGENAME}}`) are parsed as `Template` by default; profiles or
consumers may reclassify them.

```ts
interface Template {
  type: "template";
  name: string;
  children: TemplateArgument[];
}

interface TemplateArgument {
  type: "template-argument";
  name?: string;  // undefined for positional args
  children: WikistNode[];  // argument value
}
```

### Argument

Triple-brace parameter: `{{{paramname|default}}}`.

```ts
interface Argument {
  type: "argument";
  name: string;
  default?: string;
}
```

### ParserFunction

Parser functions use `{{ }}` syntax with a `#` prefix on the name:
`{{#if:condition|then|else}}`, `{{#switch:...}}`, `{{#invoke:...}}`.

The `#` prefix is the syntactic marker that distinguishes parser functions from
templates and magic words. A source parser can classify based on this prefix
alone, without knowing MediaWiki configuration.

```ts
interface ParserFunction {
  type: "parser-function";
  name: string;  // e.g. "#if", "#switch", "#invoke"
  children: TemplateArgument[];
}
```

### MagicWord

Variable-style magic words: `{{PAGENAME}}`, `{{CURRENTYEAR}}`,
`{{FULLPAGENAME}}`. These are a configured set of names that MediaWiki
recognizes and substitutes before template lookup.

Unlike parser functions, magic words have no `#` prefix. A source parser
cannot distinguish a magic word from a template without knowing the configured
word list. The default strategy: parse as `Template`, let profiles or
consumers reclassify known magic words based on name matching. The `MagicWord`
node type exists for consumers that perform this reclassification.

```ts
interface MagicWord {
  type: "magic-word";
  name: string;  // e.g. "PAGENAME", "CURRENTYEAR"
}
```

### BehaviorSwitch

Double-underscore switches: `__TOC__`, `__NOTOC__`, `__FORCETOC__`,
`__NOEDITSECTION__`, etc.

```ts
interface BehaviorSwitch {
  type: "behavior-switch";
  name: string;  // e.g. "TOC", "NOTOC"
}
```

### HtmlTag

HTML tags in wikitext. Covers both standard HTML and MediaWiki extension tags
(`<ref>`, `<nowiki>`, `<gallery>`, `<syntaxhighlight>`, etc.).

```ts
interface HtmlTag {
  type: "html-tag";
  tag_name: string;
  self_closing: boolean;
  attributes?: Record<string, string>;
  children: WikistNode[];  // content between open and close tags
}
```

### HtmlEntity

HTML character entities: `&amp;`, `&#123;`, `&#x7b;`.

```ts
interface HtmlEntity {
  type: "html-entity";
  value: string;  // the raw entity text including & and ;
}
```

### Text

Literal text content. The leaf node for all inline text that is not markup.

```ts
interface Text {
  type: "text";
  value: string;
}
```

### Nowiki

Content inside `<nowiki>...</nowiki>` tags. Markup within is not parsed.

```ts
interface Nowiki {
  type: "nowiki";
  value: string;
}
```

### Comment

HTML comments: `<!-- comment text -->`.

```ts
interface Comment {
  type: "comment";
  value: string;  // content between <!-- and -->
}
```

### Redirect

Page redirect: `#REDIRECT [[Target]]`.

```ts
interface Redirect {
  type: "redirect";
  target: string;
  children: WikistNode[];  // the wikilink node
}
```

### Signature

Signature markers: `~~~` (username), `~~~~` (username + timestamp),
`~~~~~` (timestamp only).

```ts
interface Signature {
  type: "signature";
  tildes: 3 | 4 | 5;
}
```

### Break

Explicit line break: `<br>` or `<br/>`.

```ts
interface Break {
  type: "break";
}
```

### Gallery

Gallery blocks: `<gallery>` with image entries.

```ts
interface Gallery {
  type: "gallery";
  attributes?: Record<string, string>;
  children: WikistNode[];
}
```

### Reference

Reference/citation: `<ref>content</ref>` or `<ref name="x"/>`.

```ts
interface Reference {
  type: "reference";
  name?: string;
  group?: string;
  children: WikistNode[];
}
```


## Discriminated union

All node types form a discriminated union on the `type` field:

```ts
type WikistNode =
  | Root | Heading | Paragraph | ThematicBreak | Preformatted
  | List | ListItem | DefinitionList | DefinitionTerm | DefinitionDescription
  | Table | TableCaption | TableRow | TableCell
  | Bold | Italic | BoldItalic
  | Wikilink | ExternalLink | ImageLink | CategoryLink
  | Template | TemplateArgument | Argument | ParserFunction
  | MagicWord | BehaviorSwitch
  | HtmlTag | HtmlEntity
  | Text | Nowiki | Comment
  | Redirect | Signature | Break | Gallery | Reference
  | Conflict;
```

This enables exhaustive `switch` on `node.type` with TypeScript's control flow
analysis.


## Tree invariants

1. **Root is always the top node.** `parse()` always returns a `Root`.
2. **Block nodes appear only as children of Root** (or other block containers
   like ListItem, TableCell).
3. **Inline nodes appear only inside block containers** (Paragraph, Heading,
   ListItem, TableCell, etc.).
4. **Text is always a leaf.** `Text` nodes have no children.
5. **Positions are monotonically increasing.** Within a parent's children,
   `start.offset` of child N+1 >= `end.offset` of child N.
6. **Source coverage.** For any input, all source characters are accounted for
   by the tree's position ranges. Leaf nodes cover content characters (text,
   whitespace). Delimiter characters (e.g., `'''` for bold, `[[`/`]]` for
   links, `{|`/`|}` for tables) are covered by their parent node's position
   range but are not represented as separate leaf nodes. This means the union
   of all node position ranges (including parents) covers the full input, but
   the leaf-only ranges may have gaps at delimiter boundaries.


## Type guards and builders

The `ast.ts` module exports type guard functions and builder helpers:

```ts
// Type guards: narrow WikistNode to a specific type
function isHeading(node: WikistNode): node is Heading;
function isTemplate(node: WikistNode): node is Template;
function isText(node: WikistNode): node is Text;
// ... one per node type

// Builders: construct nodes with required fields
function heading(level: 1|2|3|4|5|6, children: WikistNode[]): Heading;
function text(value: string): Text;
function template(name: string, args: TemplateArgument[]): Template;
// ... one per node type
```

Type guards enable safe narrowing in `filter()` and `visit()` callbacks.
Builders enforce required fields at construction time.


## Reserved: Conflict node

The `Conflict` type name is reserved for future collaboration support. It
represents multiple possible variants for a range of content, inspired by
jujutsu's "conflict as value" model.

```ts
interface Conflict {
  type: "conflict";
  variants: WikistNode[][];  // each variant is a list of children
}
```

This node type is **not produced by the core parser** and is **not included
in type guards or builders** in MVP. It exists as a reserved slot so that
collaboration tooling can represent unresolved conflicts in the tree without
requiring a breaking AST change later.

Conflict events are still stack-well-formed: an `enter("conflict")` /
`exit("conflict")` pair wraps the conflicting region. `stringify` can
serialize conflict markers in a controlled way or omit them.
