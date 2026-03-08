/**
 * Wikist node types, type guards, and builder functions.
 *
 * A token stream is great for scanning. An event stream is great for streaming
 * work. But sometimes a caller wants something it can hold onto, walk later,
 * and inspect with normal tree code. That is where the Wikist tree comes in.
 *
 * A Wikist tree is the parser's structured view of a wikitext document. It is
 * the same document shape the event stream describes, but materialized as
 * nested objects.
 *
 * For example, this source:
 *
 * ```
 * == Introduction ==
 * This is '''bold''' and ''italic'' text.
 *
 * * First item
 * * Second item
 * ```
 *
 * becomes a tree shaped roughly like this:
 *
 * ```
 * root
 * ├── heading (level: 2)
 * │   └── text "Introduction"
 * ├── paragraph
 * │   ├── text "This is "
 * │   ├── bold
 * │   │   └── text "bold"
 * │   ├── text " and "
 * │   ├── italic
 * │   │   └── text "italic"
 * │   └── text " text."
 * └── list (ordered: false)
 *     ├── list-item
 *     │   └── text "First item"
 *     └── list-item
 *         └── text "Second item"
 * ```
 *
 * The tree follows the same broad shape as unist, which is the small shared
 * tree format used across tools like remark and rehype. In practice, that just
 * means every node has a string `type`, some nodes have `children`, some have
 * `value`, and positions are optional.
 *
 * This file uses three broad node shapes because they are useful when walking a
 * tree:
 *
 * - parent nodes hold other nodes in `children`
 * - literal nodes hold string content in `value`
 * - void nodes are stand-alone markers with neither `children` nor `value`
 *
 * Those names are common in syntax-tree libraries, but the practical version is
 * simpler: some nodes contain other nodes, some directly hold text, and some
 * are just markers.
 *
 * The module also gives you three kinds of helpers:
 *
 * 1. type guards such as `isHeading()` and `isText()`
 * 2. builder functions such as `heading()` and `text()`
 * 3. grouped unions such as `WikistParent` for generic tree code
 *
 * @example Walking a tree to collect visible text
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isParent, isText } from './ast.ts';
 *
 * function collectText(node: WikistNode): string {
 *   if (isText(node)) return node.value;
 *   if (isParent(node)) return node.children.map(collectText).join('');
 *   return '';
 * }
 * ```
 *
 * @example Building a small tree by hand
 * ```ts
 * import { root, heading, text } from './ast.ts';
 *
 * const tree = root([
 *   heading(2, [text('Hello world')]),
 * ]);
 * ```
 *
 * @module
 */

import type { Position } from './events.ts';

// ---------------------------------------------------------------------------
// Base type
// ---------------------------------------------------------------------------
//
// All wikist node interfaces extend WikistNodeBase to inherit common fields
// (`position` and `data`). This avoids repeating them in every interface.
// It's the same pattern used by unist, mdast, and hast.

/**
 * Common fields shared by all Wikist nodes.
 *
 * Concrete node interfaces extend this base so they all agree on where source
 * positions live and where extra metadata can be attached. Both fields are
 * optional because a node you build by hand may not come from a source file,
 * and many callers will never need extra metadata at all.
 */
export interface WikistNodeBase {
  /**
   * Source location of this node in the original input.
   *
   * Absent for programmatically constructed nodes that do not correspond
   * to a source range.
   */
  readonly position?: Position;

  /**
   * Optional extra metadata for tools built on top of the core parser.
   *
   * Not used by the core parser. Available for consumers, plugins, and
   * extensions that need to attach arbitrary data to nodes.
   */
  readonly data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Block-level parent nodes
// ---------------------------------------------------------------------------
//
// Block-level nodes represent the top-level structural elements of a
// wikitext document: headings, paragraphs, lists, tables, preformatted
// blocks, and horizontal rules.
//
// In wikitext, block structure is determined by line-start markers:
//
//   = Heading =         → Heading
//   plain text          → Paragraph
//    leading space      → Preformatted
//   * bullet            → List (unordered)
//   # numbered          → List (ordered)
//   ; term              → DefinitionList / DefinitionTerm
//   : description       → DefinitionList / DefinitionDescription
//   ----                → ThematicBreak
//   {| ... |}           → Table
//

/**
 * The top-level document node. Every parse result is a `Root`. Contains
 * block-level children.
 *
 * @example A root with one heading
 * ```ts
 * import type { Root } from './ast.ts';
 *
 * const tree: Root = {
 *   type: 'root',
 *   children: [{ type: 'heading', level: 2, children: [{ type: 'text', value: 'Title' }] }],
 * };
 * ```
 */
export interface Root extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'root';
  /** Block-level children. */
  readonly children: WikistNode[];
}

/**
 * A section heading. In wikitext, headings are written with `=` markers:
 *
 * ```
 * = Level 1 =        →  depth 1 (rarely used; the page title is level 1)
 * == Level 2 ==      →  depth 2 (most common section heading)
 * === Level 3 ===    →  depth 3
 * ...up to 6
 * ```
 *
 * The `level` field captures the number of `=` markers (1 through 6).
 */
export interface Heading extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'heading';
  /** Heading depth: 1 for `=`, 2 for `==`, up to 6 for `======`. */
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Inline content within the heading. */
  readonly children: WikistNode[];
}

/**
 * A block of inline content separated by blank lines or other block
 * elements.
 */
export interface Paragraph extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'paragraph';
  /** Inline content within the paragraph. */
  readonly children: WikistNode[];
}

/**
 * Lines starting with a space character. In wikitext, a leading space
 * makes a line preformatted (rendered as `<pre>` in MediaWiki):
 *
 * ```
 *  This line starts with a space    → Preformatted
 *  So does this one                 → same Preformatted block
 * ```
 */
export interface Preformatted extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'preformatted';
  /** Content within the preformatted block. */
  readonly children: WikistNode[];
}

/**
 * Bullet lists (`*`) or ordered lists (`#`). In wikitext, list items
 * start with one of these markers at the beginning of a line:
 *
 * ```
 * * First bullet       → List (ordered: false)
 * * Second bullet        ├── ListItem (marker: '*')
 * ** Nested bullet       └── ListItem (marker: '**') → nested List
 *
 * # First numbered     → List (ordered: true)
 * # Second numbered      ├── ListItem (marker: '#')
 * ```
 *
 * Lists nest when markers are stacked (`**` for a nested bullet). Mixed
 * markers (`*#`) create heterogeneous nesting.
 */
export interface List extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'list';
  /** `true` for `#` (ordered) lists, `false` for `*` (bullet) lists. */
  readonly ordered: boolean;
  /** The list items in this list. */
  readonly children: ListItem[];
}

/**
 * A single item within a {@linkcode List}.
 */
export interface ListItem extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'list-item';
  /** Raw marker characters from the source (e.g., `"**"` or `"#*"`). */
  readonly marker: string;
  /** Content of this list item (inline and nested block nodes). */
  readonly children: WikistNode[];
}

/**
 * A definition list, using `;` for terms and `:` for descriptions.
 * In wikitext:
 *
 * ```
 * ; Term           → DefinitionTerm
 * : Description    → DefinitionDescription
 * ; Another term
 * : Its definition
 * ```
 *
 * The `:` marker is also used for block-level indentation (common on
 * talk pages), even when there is no corresponding term.
 */
export interface DefinitionList extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'definition-list';
  /** Terms and descriptions in this definition list. */
  readonly children: (DefinitionTerm | DefinitionDescription)[];
}

/**
 * A term within a {@linkcode DefinitionList} (`;` marker).
 */
export interface DefinitionTerm extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'definition-term';
  /** Inline content of the term. */
  readonly children: WikistNode[];
}

/**
 * A description within a {@linkcode DefinitionList} (`:` marker).
 */
export interface DefinitionDescription extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'definition-description';
  /** Inline content of the description. */
  readonly children: WikistNode[];
}

/**
 * A table structure. In wikitext, tables use a distinctive syntax
 * with pipe characters:
 *
 * ```
 * {| class="wikitable"    → Table (attributes: 'class="wikitable"')
 * |+ Caption text          → TableCaption
 * |-                       → TableRow separator
 * ! Header 1 !! Header 2  → TableCell (header: true)
 * |-
 * | Data 1 || Data 2      → TableCell (header: false)
 * |}                       → Table close
 * ```
 */
export interface Table extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'table';
  /** Raw attribute string from the `{|` opening line, if present. */
  readonly attributes?: string;
  /** Table caption and rows. */
  readonly children: (TableCaption | TableRow)[];
}

/**
 * A table caption (`|+`).
 */
export interface TableCaption extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'table-caption';
  /** Inline content of the caption. */
  readonly children: WikistNode[];
}

/**
 * A table row (`|-` or implicit first row).
 */
export interface TableRow extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'table-row';
  /** Raw attribute string from the `|-` row line, if present. */
  readonly attributes?: string;
  /** Cells in this row. */
  readonly children: TableCell[];
}

/**
 * A single table cell. Header cells (`!`) have `header: true`; data
 * cells (`|`) have `header: false`.
 */
export interface TableCell extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'table-cell';
  /** `true` for `!` header cells, `false` for `|` data cells. */
  readonly header: boolean;
  /** Raw attribute string before the cell content, if present. */
  readonly attributes?: string;
  /** Inline content of the cell. */
  readonly children: WikistNode[];
}

// ---------------------------------------------------------------------------
// Inline parent nodes
// ---------------------------------------------------------------------------
//
// Inline nodes represent formatting and linking within a line of text.
// In wikitext:
//
//   '''bold'''              → Bold
//   ''italic''              → Italic
//   '''''bold italic'''''   → BoldItalic
//   [[Target|text]]         → Wikilink
//   [https://url text]      → ExternalLink
//   [[File:Img.png|opts]]   → ImageLink
//   {{Template|arg}}        → Template
//   {{#if:...|...|...}}     → ParserFunction
//   <div class="x">...</div> → HtmlTag
//   #REDIRECT [[Target]]    → Redirect

/**
 * Bold text. In wikitext, bold is marked with three apostrophes:
 * `'''bold text'''`.
 */
export interface Bold extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'bold';
  /** Inline content wrapped in bold. */
  readonly children: WikistNode[];
}

/**
 * Italic text. In wikitext, italic is marked with two apostrophes:
 * `''italic text''`.
 */
export interface Italic extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'italic';
  /** Inline content wrapped in italic. */
  readonly children: WikistNode[];
}

/**
 * Bold and italic text combined. In wikitext, five apostrophes mark both:
 * `'''''bold italic'''''`.
 */
export interface BoldItalic extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'bold-italic';
  /** Inline content wrapped in bold and italic. */
  readonly children: WikistNode[];
}

/**
 * Internal wiki link: `[[Target]]` or `[[Target|display text]]`.
 *
 * A leading colon in the target (`[[:Category:Foo]]`) produces a visible
 * link instead of a category assignment. The parser strips the leading
 * colon during namespace dispatch.
 *
 * The `target` field is a convenience extraction from the source range.
 * For exact source text, slice the input using
 * `position.start.offset` / `position.end.offset`.
 */
export interface Wikilink extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'wikilink';
  /** Link target (page title). Extracted from source; may be lossy. */
  readonly target: string;
  /** Display text nodes. Empty when the target is used as-is. */
  readonly children: WikistNode[];
}

/**
 * External link: `[https://example.com text]` or a bare URL.
 */
export interface ExternalLink extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'external-link';
  /** The URL target. */
  readonly url: string;
  /** Display text nodes. */
  readonly children: WikistNode[];
}

/**
 * Image embed: `[[File:Example.png|thumb|Caption]]` or
 * `[[Image:...]]`.
 *
 * A leading colon (`[[:File:Foo.png]]`) produces a {@linkcode Wikilink}
 * instead (visible link to the file page, not an image embed).
 */
export interface ImageLink extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'image-link';
  /** Filename including namespace (e.g., `"File:Example.png"`). */
  readonly target: string;
  /** Option and caption parts. */
  readonly children: WikistNode[];
}

/**
 * Template transclusion: `{{TemplateName|arg1|name=value}}`.
 *
 * Also the default node type for `{{ }}` constructs that cannot be
 * classified as parser functions (which have a `#` prefix) without
 * MediaWiki configuration. Variable-style magic words (`{{PAGENAME}}`)
 * are parsed as `Template` by default; profiles or consumers may
 * reclassify them.
 *
 * The `{{ }}` family of constructs all share the same delimiter syntax
 * but differ in behavior:
 *
 * | Wikitext | Node | Why |
 * |----------|------|-----|
 * | `{{Infobox\|...}}` | Template | no `#` prefix, default classification |
 * | `{{#if:...\|...}}` | ParserFunction | `#` prefix identifies it |
 * | `{{PAGENAME}}` | Template (initially) | looks like a template; profiles may reclassify as MagicWord |
 * | `{{{1\|default}}}` | Argument | triple braces, not double |
 *
 * A source parser cannot distinguish variable-style magic words from
 * templates without MediaWiki's configured word list, so both parse as
 * Template by default. This is a deliberate design choice: the parser
 * stays configuration-free and lets consumers apply knowledge of which
 * words are "magic" in their environment.
 */
export interface Template extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'template';
  /** Template name (e.g., `"Infobox"`, `"PAGENAME"`). */
  readonly name: string;
  /** Template arguments (positional and named). */
  readonly children: TemplateArgument[];
}

/**
 * A single argument within a {@linkcode Template} or
 * {@linkcode ParserFunction}.
 */
export interface TemplateArgument extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'template-argument';
  /** Argument name for named args (`name=value`). Absent for positional args. */
  readonly name?: string;
  /** Argument value content. */
  readonly children: WikistNode[];
}

/**
 * Parser function: `{{#if:cond|then|else}}`, `{{#switch:...}}`, etc.
 *
 * Distinguished from templates by the `#` prefix on the name. A source
 * parser can classify based on this prefix alone, without MediaWiki
 * configuration.
 */
export interface ParserFunction extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'parser-function';
  /** Function name including `#` prefix (e.g., `"#if"`, `"#switch"`). */
  readonly name: string;
  /** Function arguments. */
  readonly children: TemplateArgument[];
}

/**
 * HTML tag in wikitext. Covers both standard HTML and MediaWiki extension
 * tags (`<ref>`, `<nowiki>`, `<gallery>`, etc.).
 */
export interface HtmlTag extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'html-tag';
  /** Tag name (e.g., `"div"`, `"ref"`, `"syntaxhighlight"`). */
  readonly tag_name: string;
  /** Whether this tag is self-closing (`<br/>`). */
  readonly self_closing: boolean;
  /** Tag attributes as key-value pairs, if present. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** Content between open and close tags. */
  readonly children: WikistNode[];
}

/**
 * Page redirect: `#REDIRECT [[Target]]`.
 */
export interface Redirect extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'redirect';
  /** Redirect target page title. */
  readonly target: string;
  /** The wikilink node representing the redirect target. */
  readonly children: WikistNode[];
}

/**
 * Gallery block: `<gallery>` with image entries.
 */
export interface Gallery extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'gallery';
  /** Gallery tag attributes, if present. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** Gallery content (images and captions). */
  readonly children: WikistNode[];
}

/**
 * Reference / citation: `<ref>content</ref>` or `<ref name="x"/>`.
 */
export interface Reference extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'reference';
  /** Named reference identifier, if present. */
  readonly name?: string;
  /** Reference group, if present. */
  readonly group?: string;
  /** Reference content. */
  readonly children: WikistNode[];
}

// ---------------------------------------------------------------------------
// Void nodes (no children, no value)
// ---------------------------------------------------------------------------
//
// Void nodes are leaf nodes with no content: they represent markers,
// switches, and structural elements that stand alone.
//
// In wikitext:
//   ----                → ThematicBreak (horizontal rule)
//   [[Category:Foo]]    → CategoryLink (assigns page to category)
//   {{{param|default}}} → Argument (template parameter reference)
//   {{PAGENAME}}        → MagicWord (runtime variable)
//   __TOC__             → BehaviorSwitch (alters page behavior)
//   ~~~~                → Signature (username + timestamp)
//   <br/>               → Break (line break)

/**
 * Horizontal rule: `----` (four or more dashes at line start).
 */
export interface ThematicBreak extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'thematic-break';
}

/**
 * Category tag: `[[Category:Name]]` or `[[Category:Name|sort key]]`.
 *
 * A leading colon (`[[:Category:Foo]]`) produces a {@linkcode Wikilink}
 * instead (visible link to the category page, not a category assignment).
 */
export interface CategoryLink extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'category-link';
  /** Category name. */
  readonly target: string;
  /** Optional sort key for ordering within the category. */
  readonly sort_key?: string;
}

/**
 * Triple-brace parameter reference: `{{{paramname|default}}}`.
 */
export interface Argument extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'argument';
  /** Parameter name. */
  readonly name: string;
  /** Default value if the parameter is not supplied. */
  readonly default?: string;
}

/**
 * Variable-style magic word: `{{PAGENAME}}`, `{{CURRENTYEAR}}`, etc.
 *
 * A source parser cannot distinguish magic words from templates without
 * the configured word list. The default strategy: parse as
 * {@linkcode Template}, let profiles or consumers reclassify.
 */
export interface MagicWord extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'magic-word';
  /** Magic word name (e.g., `"PAGENAME"`, `"CURRENTYEAR"`). */
  readonly name: string;
}

/**
 * Double-underscore behavior switch: `__TOC__`, `__NOTOC__`, etc.
 *
 * Behavior switches alter how MediaWiki renders a page without producing
 * visible content. Common examples:
 *
 * | Switch | Effect |
 * |--------|--------|
 * | `__TOC__` | Place the table of contents here |
 * | `__NOTOC__` | Suppress the table of contents |
 * | `__NOEDITSECTION__` | Hide section edit links |
 * | `__FORCETOC__` | Force the table of contents even with few headings |
 *
 * The tokenizer emits a `BEHAVIOR_SWITCH` token for any `__LETTERS__`
 * pattern (ASCII letters between double underscores). The AST node then
 * stores the word without the underscores in the `name` field. Whether
 * the word is actually recognized by a given MediaWiki installation is
 * a consumer/profile concern: extensions can register new switches, so
 * the full set is not fixed.
 */
export interface BehaviorSwitch extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'behavior-switch';
  /** Switch name without underscores (e.g., `"TOC"`, `"NOTOC"`). */
  readonly name: string;
}

/**
 * Signature marker: `~~~` (username), `~~~~` (username + timestamp),
 * or `~~~~~` (timestamp only).
 */
export interface Signature extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'signature';
  /** Number of tildes: 3, 4, or 5. */
  readonly tildes: 3 | 4 | 5;
}

/**
 * Explicit line break: `<br>` or `<br/>`.
 */
export interface Break extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'break';
}

// ---------------------------------------------------------------------------
// Literal nodes (have value, no children)
// ---------------------------------------------------------------------------
//
// Literal nodes carry a string `value` instead of `children`. They
// represent text content that the parser does not further decompose:
//
//   Hello world        → Text (value: 'Hello world')
//   &amp;              → HtmlEntity (value: '&amp;')
//   <nowiki>[[x]]</nowiki> → Nowiki (value: '[[x]]')
//   <!-- hidden -->    → Comment (value: ' hidden ')

/**
 * Literal text content. The leaf node for all inline text that is not
 * markup.
 */
export interface Text extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'text';
  /** The text content. */
  readonly value: string;
}

/**
 * HTML character entity: `&amp;`, `&#123;`, `&#x7b;`.
 */
export interface HtmlEntity extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'html-entity';
  /** Raw entity text including `&` and `;` (e.g., `"&amp;"`). */
  readonly value: string;
}

/**
 * Content inside `<nowiki>...</nowiki>` tags. Markup within is not
 * parsed.
 */
export interface Nowiki extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'nowiki';
  /** Raw text content (not parsed for markup). */
  readonly value: string;
}

/**
 * HTML comment: `<!-- comment text -->`.
 */
export interface Comment extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'comment';
  /** Comment content between `<!--` and `-->`. */
  readonly value: string;
}

// ---------------------------------------------------------------------------
// Reserved
// ---------------------------------------------------------------------------

/**
 * Reserved for future collaboration support. Represents multiple possible
 * variants for a range of content, inspired by jujutsu's "conflict as
 * value" model.
 *
 * **Not produced by the core parser.** Exists as a reserved slot so that
 * collaboration tooling can represent unresolved conflicts in the tree
 * without requiring a breaking AST change later.
 */
export interface Conflict extends WikistNodeBase {
  /** Node type discriminant. */
  readonly type: 'conflict';
  /** Each variant is a list of children representing one conflict side. */
  readonly variants: WikistNode[][];
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------
//
// WikistNode is a TypeScript "discriminated union": a union of interfaces
// that all share a common `type` field with a unique string literal value.
// This lets the compiler narrow the type inside a switch statement:
//
//   switch (node.type) {
//     case 'heading':    node.level;     // TypeScript knows this is a Heading
//     case 'text':       node.value;     // TypeScript knows this is a Text
//     case 'bold':       node.children;  // TypeScript knows this is a Bold
//   }
//
// Why this matters: without the union, you would need explicit casts or
// type assertions to access type-specific fields. The discriminated union
// makes the compiler do the narrowing for you, catching mismatches at
// compile time:
//
//   if (node.type === 'heading') {
//     node.level;   // level is accessible here
//     node.value;   // compile error: Heading has no `value`
//   }
//
// The pattern appears throughout this codebase: WikistNode, WikitextEvent,
// and TokenType all use discriminated unions for type-safe branching.

/**
 * Discriminated union of all wikist node types. Switch on `node.type`
 * for exhaustive pattern matching.
 *
 * @example Exhaustive switch
 * ```ts
 * import type { WikistNode } from './ast.ts';
 *
 * function nodeLabel(node: WikistNode): string {
 *   switch (node.type) {
 *     case 'root': return 'document';
 *     case 'heading': return `h${node.level}`;
 *     case 'text': return node.value;
 *     default: return node.type;
 *   }
 * }
 * ```
 */
export type WikistNode =
  | Root
  | Heading
  | Paragraph
  | ThematicBreak
  | Preformatted
  | List
  | ListItem
  | DefinitionList
  | DefinitionTerm
  | DefinitionDescription
  | Table
  | TableCaption
  | TableRow
  | TableCell
  | Bold
  | Italic
  | BoldItalic
  | Wikilink
  | ExternalLink
  | ImageLink
  | CategoryLink
  | Template
  | TemplateArgument
  | Argument
  | ParserFunction
  | MagicWord
  | BehaviorSwitch
  | HtmlTag
  | HtmlEntity
  | Text
  | Nowiki
  | Comment
  | Redirect
  | Signature
  | Break
  | Gallery
  | Reference
  | Conflict;

/**
 * String literal union of all wikist node type discriminants.
 *
 * Derived from {@linkcode WikistNode} for type-safe switching and
 * mapping.
 */
export type WikistNodeType = WikistNode['type'];

/** Alias for the root node type returned by `parse()`. */
export type WikistRoot = Root;

// ---------------------------------------------------------------------------
// Category aliases
// ---------------------------------------------------------------------------
//
// These union types group nodes by structural category. They are useful
// for generic tree-walking code that cares about "does this node have
// children?" rather than "is this specific node type a heading or a bold?"
//
// isParent(node) narrows WikistNode → WikistParent  (has children)
// isLiteral(node) narrows WikistNode → WikistLiteral (has value)
// WikistVoid covers the rest         (has neither)

/**
 * Union of all parent node types (nodes with a `children` field).
 */
export type WikistParent =
  | Root
  | Heading
  | Paragraph
  | Preformatted
  | List
  | ListItem
  | DefinitionList
  | DefinitionTerm
  | DefinitionDescription
  | Table
  | TableCaption
  | TableRow
  | TableCell
  | Bold
  | Italic
  | BoldItalic
  | Wikilink
  | ExternalLink
  | ImageLink
  | Template
  | TemplateArgument
  | ParserFunction
  | HtmlTag
  | Redirect
  | Gallery
  | Reference;

/**
 * Union of all literal node types (nodes with a `value` field).
 */
export type WikistLiteral =
  | HtmlEntity
  | Text
  | Nowiki
  | Comment;

/**
 * Union of all void node types (no `children`, no `value`).
 */
export type WikistVoid =
  | ThematicBreak
  | CategoryLink
  | Argument
  | MagicWord
  | BehaviorSwitch
  | Signature
  | Break;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------
//
// Type guards are functions that narrow a general WikistNode to a specific
// type. They return a "type predicate" (e.g., `node is Heading`) that tells
// TypeScript to narrow the type inside an `if` block.
//
// Two kinds of type guards:
//
//   1. Category guards: isParent(node), isLiteral(node)
//      Use structural checks ('children' in node, 'value' in node).
//      Work with future node types too.
//
//   2. Specific guards: isHeading(node), isText(node), etc.
//      Check node.type === 'heading', node.type === 'text', etc.
//      Give access to type-specific fields (level, value, target...).
//
// Type guards are especially useful as callbacks:
//   const headings = nodes.filter(isHeading);  // Heading[]

/**
 * Narrow a {@linkcode WikistNode} to any parent node (has `children`).
 *
 * Uses the `children` property as a structural check rather than
 * enumerating all parent types, so it also works with future parent
 * node types.
 *
 * @example Recursively visiting children
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isParent } from './ast.ts';
 *
 * function visit(node: WikistNode, fn: (n: WikistNode) => void) {
 *   fn(node);
 *   if (isParent(node)) node.children.forEach(child => visit(child, fn));
 * }
 * ```
 *
 * @example Filtering parent nodes from a flat list
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isParent } from './ast.ts';
 *
 * function parents(nodes: WikistNode[]) {
 *   return nodes.filter(isParent);
 * }
 * ```
 */
export function isParent(node: WikistNode): node is WikistParent {
  return 'children' in node;
}

/**
 * Narrow a {@linkcode WikistNode} to any literal node (has `value`).
 *
 * @example Collecting all literal values
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isLiteral } from './ast.ts';
 *
 * function literalValues(nodes: WikistNode[]): string[] {
 *   return nodes.filter(isLiteral).map(n => n.value);
 * }
 * ```
 *
 * @example Narrowing to access the value field
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isLiteral } from './ast.ts';
 *
 * function showNode(node: WikistNode) {
 *   if (isLiteral(node)) console.log('literal:', node.value);
 * }
 * ```
 */
export function isLiteral(node: WikistNode): node is WikistLiteral {
  return 'value' in node;
}

/** Narrow to {@linkcode Root}. */
export function isRoot(node: WikistNode): node is Root {
  return node.type === 'root';
}

/**
 * Narrow to {@linkcode Heading}.
 *
 * @example Extracting all headings from a tree
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isHeading, isParent } from './ast.ts';
 *
 * function headings(node: WikistNode): WikistNode[] {
 *   const result: WikistNode[] = [];
 *   if (isHeading(node)) result.push(node);
 *   if (isParent(node)) node.children.forEach(c => result.push(...headings(c)));
 *   return result;
 * }
 * ```
 */
export function isHeading(node: WikistNode): node is Heading {
  return node.type === 'heading';
}

/** Narrow to {@linkcode Paragraph}. */
export function isParagraph(node: WikistNode): node is Paragraph {
  return node.type === 'paragraph';
}

/** Narrow to {@linkcode ThematicBreak}. */
export function isThematicBreak(node: WikistNode): node is ThematicBreak {
  return node.type === 'thematic-break';
}

/** Narrow to {@linkcode Preformatted}. */
export function isPreformatted(node: WikistNode): node is Preformatted {
  return node.type === 'preformatted';
}

/** Narrow to {@linkcode List}. */
export function isList(node: WikistNode): node is List {
  return node.type === 'list';
}

/** Narrow to {@linkcode ListItem}. */
export function isListItem(node: WikistNode): node is ListItem {
  return node.type === 'list-item';
}

/** Narrow to {@linkcode DefinitionList}. */
export function isDefinitionList(node: WikistNode): node is DefinitionList {
  return node.type === 'definition-list';
}

/** Narrow to {@linkcode DefinitionTerm}. */
export function isDefinitionTerm(node: WikistNode): node is DefinitionTerm {
  return node.type === 'definition-term';
}

/** Narrow to {@linkcode DefinitionDescription}. */
export function isDefinitionDescription(node: WikistNode): node is DefinitionDescription {
  return node.type === 'definition-description';
}

/** Narrow to {@linkcode Table}. */
export function isTable(node: WikistNode): node is Table {
  return node.type === 'table';
}

/** Narrow to {@linkcode TableCaption}. */
export function isTableCaption(node: WikistNode): node is TableCaption {
  return node.type === 'table-caption';
}

/** Narrow to {@linkcode TableRow}. */
export function isTableRow(node: WikistNode): node is TableRow {
  return node.type === 'table-row';
}

/** Narrow to {@linkcode TableCell}. */
export function isTableCell(node: WikistNode): node is TableCell {
  return node.type === 'table-cell';
}

/** Narrow to {@linkcode Bold}. */
export function isBold(node: WikistNode): node is Bold {
  return node.type === 'bold';
}

/** Narrow to {@linkcode Italic}. */
export function isItalic(node: WikistNode): node is Italic {
  return node.type === 'italic';
}

/** Narrow to {@linkcode BoldItalic}. */
export function isBoldItalic(node: WikistNode): node is BoldItalic {
  return node.type === 'bold-italic';
}

/**
 * Narrow to {@linkcode Wikilink}.
 *
 * @example Finding all wikilinks in a tree
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isWikilink, isParent } from './ast.ts';
 *
 * function links(node: WikistNode): string[] {
 *   const result: string[] = [];
 *   if (isWikilink(node)) result.push(node.target);
 *   if (isParent(node)) node.children.forEach(c => result.push(...links(c)));
 *   return result;
 * }
 * ```
 */
export function isWikilink(node: WikistNode): node is Wikilink {
  return node.type === 'wikilink';
}

/** Narrow to {@linkcode ExternalLink}. */
export function isExternalLink(node: WikistNode): node is ExternalLink {
  return node.type === 'external-link';
}

/** Narrow to {@linkcode ImageLink}. */
export function isImageLink(node: WikistNode): node is ImageLink {
  return node.type === 'image-link';
}

/** Narrow to {@linkcode CategoryLink}. */
export function isCategoryLink(node: WikistNode): node is CategoryLink {
  return node.type === 'category-link';
}

/**
 * Narrow to {@linkcode Template}.
 *
 * @example Extracting template names
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isTemplate, isParent } from './ast.ts';
 *
 * function templateNames(node: WikistNode): string[] {
 *   const result: string[] = [];
 *   if (isTemplate(node)) result.push(node.name);
 *   if (isParent(node)) node.children.forEach(c => result.push(...templateNames(c)));
 *   return result;
 * }
 * ```
 */
export function isTemplate(node: WikistNode): node is Template {
  return node.type === 'template';
}

/** Narrow to {@linkcode TemplateArgument}. */
export function isTemplateArgument(node: WikistNode): node is TemplateArgument {
  return node.type === 'template-argument';
}

/** Narrow to {@linkcode Argument}. */
export function isArgument(node: WikistNode): node is Argument {
  return node.type === 'argument';
}

/** Narrow to {@linkcode ParserFunction}. */
export function isParserFunction(node: WikistNode): node is ParserFunction {
  return node.type === 'parser-function';
}

/** Narrow to {@linkcode MagicWord}. */
export function isMagicWord(node: WikistNode): node is MagicWord {
  return node.type === 'magic-word';
}

/** Narrow to {@linkcode BehaviorSwitch}. */
export function isBehaviorSwitch(node: WikistNode): node is BehaviorSwitch {
  return node.type === 'behavior-switch';
}

/** Narrow to {@linkcode HtmlTag}. */
export function isHtmlTag(node: WikistNode): node is HtmlTag {
  return node.type === 'html-tag';
}

/** Narrow to {@linkcode HtmlEntity}. */
export function isHtmlEntity(node: WikistNode): node is HtmlEntity {
  return node.type === 'html-entity';
}

/**
 * Narrow to {@linkcode Text}.
 *
 * @example Checking for text nodes
 * ```ts
 * import type { WikistNode } from './ast.ts';
 * import { isText } from './ast.ts';
 *
 * function isLeafText(node: WikistNode): boolean {
 *   return isText(node);
 * }
 * ```
 */
export function isText(node: WikistNode): node is Text {
  return node.type === 'text';
}

/** Narrow to {@linkcode Nowiki}. */
export function isNowiki(node: WikistNode): node is Nowiki {
  return node.type === 'nowiki';
}

/** Narrow to {@linkcode Comment}. */
export function isComment(node: WikistNode): node is Comment {
  return node.type === 'comment';
}

/** Narrow to {@linkcode Redirect}. */
export function isRedirect(node: WikistNode): node is Redirect {
  return node.type === 'redirect';
}

/** Narrow to {@linkcode Signature}. */
export function isSignature(node: WikistNode): node is Signature {
  return node.type === 'signature';
}

/** Narrow to {@linkcode Break}. */
export function isBreak(node: WikistNode): node is Break {
  return node.type === 'break';
}

/** Narrow to {@linkcode Gallery}. */
export function isGallery(node: WikistNode): node is Gallery {
  return node.type === 'gallery';
}

/** Narrow to {@linkcode Reference}. */
export function isReference(node: WikistNode): node is Reference {
  return node.type === 'reference';
}

// ---------------------------------------------------------------------------
// Builder functions
// ---------------------------------------------------------------------------
//
// Builder functions create wikist nodes with the correct `type` discriminant
// set automatically. They are the primary way to construct trees
// programmatically (e.g., in tests, code generators, or transformers).
//
// Each builder returns a plain object — no classes, no prototypes. This
// keeps nodes JSON-serializable and structurally compatible with unist.
//
// Example: building a small document tree
//
//   const tree = root([
//     heading(2, [text('Hello')]),
//     paragraph([text('Some '), bold([text('bold')]), text(' text.')]),
//   ]);

/**
 * Create a {@linkcode Root} node.
 *
 * @example Building a document tree
 * ```ts
 * import { root, paragraph, text } from './ast.ts';
 *
 * const tree = root([paragraph([text('Hello world.')])]);
 * tree.type;             // 'root'
 * tree.children.length;  // 1
 * ```
 *
 * @example Empty document
 * ```ts
 * import { root } from './ast.ts';
 *
 * const empty = root([]);
 * empty.children.length; // 0
 * ```
 */
export function root(children: WikistNode[]): Root {
  return { type: 'root', children };
}

/**
 * Create a {@linkcode Heading} node.
 *
 * @example Level 2 heading with text
 * ```ts
 * import { heading, text } from './ast.ts';
 *
 * const h2 = heading(2, [text('Introduction')]);
 * h2.level; // 2
 * ```
 *
 * @example Level 1 heading with formatted content
 * ```ts
 * import { heading, bold, text } from './ast.ts';
 *
 * const h1 = heading(1, [bold([text('Important')])]);
 * h1.level; // 1
 * ```
 */
export function heading(
  level: 1 | 2 | 3 | 4 | 5 | 6,
  children: WikistNode[],
): Heading {
  return { type: 'heading', level, children };
}

/**
 * Create a {@linkcode Paragraph} node.
 *
 * @example Simple paragraph
 * ```ts
 * import { paragraph, text } from './ast.ts';
 *
 * const p = paragraph([text('Some text.')]);
 * p.type; // 'paragraph'
 * ```
 */
export function paragraph(children: WikistNode[]): Paragraph {
  return { type: 'paragraph', children };
}

/**
 * Create a {@linkcode ThematicBreak} node.
 *
 * @example Inserting a horizontal rule
 * ```ts
 * import { thematicBreak } from './ast.ts';
 *
 * const hr = thematicBreak();
 * hr.type; // 'thematic-break'
 * ```
 */
export function thematicBreak(): ThematicBreak {
  return { type: 'thematic-break' };
}

/**
 * Create a {@linkcode Preformatted} node.
 *
 * @example Preformatted block
 * ```ts
 * import { preformatted, text } from './ast.ts';
 *
 * const pre = preformatted([text(' code here')]);
 * pre.type; // 'preformatted'
 * ```
 */
export function preformatted(children: WikistNode[]): Preformatted {
  return { type: 'preformatted', children };
}

/**
 * Create a {@linkcode List} node.
 *
 * @example Bullet list
 * ```ts
 * import { list, listItem, text } from './ast.ts';
 *
 * const ul = list(false, [listItem('*', [text('item')])]);
 * ul.ordered; // false
 * ```
 *
 * @example Ordered list
 * ```ts
 * import { list, listItem, text } from './ast.ts';
 *
 * const ol = list(true, [listItem('#', [text('first')])]);
 * ol.ordered; // true
 * ```
 */
export function list(ordered: boolean, children: ListItem[]): List {
  return { type: 'list', ordered, children };
}

/**
 * Create a {@linkcode ListItem} node.
 *
 * @example Bullet list item
 * ```ts
 * import { listItem, text } from './ast.ts';
 *
 * const item = listItem('*', [text('bullet point')]);
 * item.marker; // '*'
 * ```
 */
export function listItem(marker: string, children: WikistNode[]): ListItem {
  return { type: 'list-item', marker, children };
}

/**
 * Create a {@linkcode DefinitionList} node.
 *
 * @example Definition list with term and description
 * ```ts
 * import { definitionList, definitionTerm, definitionDescription, text } from './ast.ts';
 *
 * const dl = definitionList([
 *   definitionTerm([text('Term')]),
 *   definitionDescription([text('Description')]),
 * ]);
 * dl.type; // 'definition-list'
 * ```
 */
export function definitionList(
  children: (DefinitionTerm | DefinitionDescription)[],
): DefinitionList {
  return { type: 'definition-list', children };
}

/**
 * Create a {@linkcode DefinitionTerm} node.
 *
 * @example Simple term
 * ```ts
 * import { definitionTerm, text } from './ast.ts';
 *
 * const dt = definitionTerm([text('Key')]);
 * dt.type; // 'definition-term'
 * ```
 */
export function definitionTerm(children: WikistNode[]): DefinitionTerm {
  return { type: 'definition-term', children };
}

/**
 * Create a {@linkcode DefinitionDescription} node.
 *
 * @example Simple description
 * ```ts
 * import { definitionDescription, text } from './ast.ts';
 *
 * const dd = definitionDescription([text('Value')]);
 * dd.type; // 'definition-description'
 * ```
 */
export function definitionDescription(children: WikistNode[]): DefinitionDescription {
  return { type: 'definition-description', children };
}

/**
 * Create a {@linkcode Table} node.
 *
 * @example Table with one row
 * ```ts
 * import { table, tableRow, tableCell, text } from './ast.ts';
 *
 * const t = table([tableRow([tableCell(false, [text('cell')])])]);
 * t.type; // 'table'
 * ```
 */
export function table(
  children: (TableCaption | TableRow)[],
  attributes?: string,
): Table {
  // Optional fields stay omitted instead of being set to `undefined` so the
  // serialized tree stays compact and debug output reflects what was actually
  // present in source.
  return attributes !== undefined
    ? { type: 'table', attributes, children }
    : { type: 'table', children };
}

/**
 * Create a {@linkcode TableCaption} node.
 *
 * @example Caption text
 * ```ts
 * import { tableCaption, text } from './ast.ts';
 *
 * const cap = tableCaption([text('Table title')]);
 * cap.type; // 'table-caption'
 * ```
 */
export function tableCaption(children: WikistNode[]): TableCaption {
  return { type: 'table-caption', children };
}

/**
 * Create a {@linkcode TableRow} node.
 *
 * @example Row with attributes
 * ```ts
 * import { tableRow, tableCell, text } from './ast.ts';
 *
 * const row = tableRow([tableCell(false, [text('data')])], 'class="highlight"');
 * row.attributes; // 'class="highlight"'
 * ```
 */
export function tableRow(
  children: TableCell[],
  attributes?: string,
): TableRow {
  // Table rows use the same omission rule as tables: absent attributes should
  // not become noisy `attributes: undefined` fields in snapshots or JSON.
  return attributes !== undefined
    ? { type: 'table-row', attributes, children }
    : { type: 'table-row', children };
}

/**
 * Create a {@linkcode TableCell} node.
 *
 * @example Data cell
 * ```ts
 * import { tableCell, text } from './ast.ts';
 *
 * const td = tableCell(false, [text('data')]);
 * td.header; // false
 * ```
 *
 * @example Header cell
 * ```ts
 * import { tableCell, text } from './ast.ts';
 *
 * const th = tableCell(true, [text('Header')]);
 * th.header; // true
 * ```
 */
export function tableCell(
  header: boolean,
  children: WikistNode[],
  attributes?: string,
): TableCell {
  // Header/data status is structural and always explicit. Attributes are not,
  // so we only materialize them when the source actually carried them.
  return attributes !== undefined
    ? { type: 'table-cell', header, attributes, children }
    : { type: 'table-cell', header, children };
}

/**
 * Create a {@linkcode Bold} node.
 *
 * @example Bold text
 * ```ts
 * import { bold, text } from './ast.ts';
 *
 * const b = bold([text('strong')]);
 * b.type; // 'bold'
 * ```
 */
export function bold(children: WikistNode[]): Bold {
  return { type: 'bold', children };
}

/**
 * Create an {@linkcode Italic} node.
 *
 * @example Italic text
 * ```ts
 * import { italic, text } from './ast.ts';
 *
 * const em = italic([text('emphasis')]);
 * em.type; // 'italic'
 * ```
 */
export function italic(children: WikistNode[]): Italic {
  return { type: 'italic', children };
}

/**
 * Create a {@linkcode BoldItalic} node.
 *
 * @example Bold italic text
 * ```ts
 * import { boldItalic, text } from './ast.ts';
 *
 * const bi = boldItalic([text('both')]);
 * bi.type; // 'bold-italic'
 * ```
 */
export function boldItalic(children: WikistNode[]): BoldItalic {
  return { type: 'bold-italic', children };
}

/**
 * Create a {@linkcode Wikilink} node.
 *
 * @example Link with display text
 * ```ts
 * import { wikilink, text } from './ast.ts';
 *
 * const link = wikilink('Main Page', [text('home')]);
 * link.target; // 'Main Page'
 * ```
 *
 * @example Link with no display text (target is used)
 * ```ts
 * import { wikilink } from './ast.ts';
 *
 * const link = wikilink('Help:Contents', []);
 * link.children.length; // 0
 * ```
 */
export function wikilink(target: string, children: WikistNode[]): Wikilink {
  return { type: 'wikilink', target, children };
}

/**
 * Create an {@linkcode ExternalLink} node.
 *
 * @example External link with label
 * ```ts
 * import { externalLink, text } from './ast.ts';
 *
 * const link = externalLink('https://example.com', [text('Example')]);
 * link.url; // 'https://example.com'
 * ```
 */
export function externalLink(url: string, children: WikistNode[]): ExternalLink {
  return { type: 'external-link', url, children };
}

/**
 * Create an {@linkcode ImageLink} node.
 *
 * @example Image with caption
 * ```ts
 * import { imageLink, text } from './ast.ts';
 *
 * const img = imageLink('File:Photo.jpg', [text('A photo')]);
 * img.target; // 'File:Photo.jpg'
 * ```
 */
export function imageLink(target: string, children: WikistNode[]): ImageLink {
  return { type: 'image-link', target, children };
}

/**
 * Create a {@linkcode CategoryLink} node.
 *
 * @example Category with sort key
 * ```ts
 * import { categoryLink } from './ast.ts';
 *
 * const cat = categoryLink('Science', 'Physics');
 * cat.sort_key; // 'Physics'
 * ```
 *
 * @example Category without sort key
 * ```ts
 * import { categoryLink } from './ast.ts';
 *
 * const cat = categoryLink('Articles');
 * cat.sort_key; // undefined
 * ```
 */
export function categoryLink(target: string, sort_key?: string): CategoryLink {
  // Category links are often compared or serialized by tools, so leaving the
  // optional sort key absent is cleaner than storing an explicit undefined.
  return sort_key !== undefined
    ? { type: 'category-link', target, sort_key }
    : { type: 'category-link', target };
}

/**
 * Create a {@linkcode Template} node.
 *
 * @example Template with arguments
 * ```ts
 * import { template, templateArgument, text } from './ast.ts';
 *
 * const t = template('Infobox', [
 *   templateArgument([text('value')]),
 *   templateArgument([text('named')], 'key'),
 * ]);
 * t.name; // 'Infobox'
 * ```
 *
 * @example Template with no arguments
 * ```ts
 * import { template } from './ast.ts';
 *
 * const t = template('Stub', []);
 * t.children.length; // 0
 * ```
 */
export function template(name: string, children: TemplateArgument[]): Template {
  return { type: 'template', name, children };
}

/**
 * Create a {@linkcode TemplateArgument} node.
 *
 * @example Positional argument
 * ```ts
 * import { templateArgument, text } from './ast.ts';
 *
 * const arg = templateArgument([text('value')]);
 * arg.name; // undefined (positional)
 * ```
 *
 * @example Named argument
 * ```ts
 * import { templateArgument, text } from './ast.ts';
 *
 * const arg = templateArgument([text('bar')], 'foo');
 * arg.name; // 'foo'
 * ```
 */
export function templateArgument(
  children: WikistNode[],
  name?: string,
): TemplateArgument {
  // Named and positional arguments share one node type. Omitting `name` is the
  // signal that the argument was positional in source.
  return name !== undefined
    ? { type: 'template-argument', name, children }
    : { type: 'template-argument', children };
}

/**
 * Create an {@linkcode Argument} node (triple-brace parameter).
 *
 * @example Parameter with default
 * ```ts
 * import { argument } from './ast.ts';
 *
 * const arg = argument('title', 'Untitled');
 * arg.default; // 'Untitled'
 * ```
 *
 * @example Parameter without default
 * ```ts
 * import { argument } from './ast.ts';
 *
 * const arg = argument('name');
 * arg.default; // undefined
 * ```
 */
export function argument(name: string, defaultValue?: string): Argument {
  return defaultValue !== undefined
    ? { type: 'argument', name, default: defaultValue }
    : { type: 'argument', name };
}

/**
 * Create a {@linkcode ParserFunction} node.
 *
 * @example If parser function
 * ```ts
 * import { parserFunction, templateArgument, text } from './ast.ts';
 *
 * const fn = parserFunction('#if', [
 *   templateArgument([text('condition')]),
 *   templateArgument([text('then')]),
 * ]);
 * fn.name; // '#if'
 * ```
 */
export function parserFunction(
  name: string,
  children: TemplateArgument[],
): ParserFunction {
  return { type: 'parser-function', name, children };
}

/**
 * Create a {@linkcode MagicWord} node.
 *
 * @example Page name magic word
 * ```ts
 * import { magicWord } from './ast.ts';
 *
 * const mw = magicWord('PAGENAME');
 * mw.name; // 'PAGENAME'
 * ```
 */
export function magicWord(name: string): MagicWord {
  return { type: 'magic-word', name };
}

/**
 * Create a {@linkcode BehaviorSwitch} node.
 *
 * @example TOC switch
 * ```ts
 * import { behaviorSwitch } from './ast.ts';
 *
 * const sw = behaviorSwitch('TOC');
 * sw.name; // 'TOC'
 * ```
 */
export function behaviorSwitch(name: string): BehaviorSwitch {
  return { type: 'behavior-switch', name };
}

/**
 * Create an {@linkcode HtmlTag} node.
 *
 * @example A div tag with content
 * ```ts
 * import { htmlTag, text } from './ast.ts';
 *
 * const div = htmlTag('div', false, [text('content')], { class: 'note' });
 * div.tag_name;      // 'div'
 * div.self_closing;  // false
 * div.attributes;   // { class: 'note' }
 * ```
 *
 * @example A self-closing br tag
 * ```ts
 * import { htmlTag } from './ast.ts';
 *
 * const br = htmlTag('br', true, []);
 * br.self_closing; // true
 * ```
 */
export function htmlTag(
  tag_name: string,
  self_closing: boolean,
  children: WikistNode[],
  attributes?: Readonly<Record<string, string>>,
): HtmlTag {
  // Self-closing tags still use the same builder so callers can construct one
  // consistent node shape and let `self_closing` carry the semantic difference.
  return attributes !== undefined
    ? { type: 'html-tag', tag_name, self_closing, attributes, children }
    : { type: 'html-tag', tag_name, self_closing, children };
}

/**
 * Create an {@linkcode HtmlEntity} node.
 *
 * @example Named entity
 * ```ts
 * import { htmlEntity } from './ast.ts';
 *
 * const ent = htmlEntity('&amp;');
 * ent.value; // '&amp;'
 * ```
 */
export function htmlEntity(value: string): HtmlEntity {
  return { type: 'html-entity', value };
}

/**
 * Create a {@linkcode Text} node.
 *
 * @example Simple text leaf
 * ```ts
 * import { text } from './ast.ts';
 *
 * const t = text('Hello world');
 * t.value; // 'Hello world'
 * ```
 *
 * @example Empty text node
 * ```ts
 * import { text } from './ast.ts';
 *
 * const t = text('');
 * t.value; // ''
 * ```
 */
export function text(value: string): Text {
  return { type: 'text', value };
}

/**
 * Create a {@linkcode Nowiki} node.
 *
 * @example Nowiki content
 * ```ts
 * import { nowiki } from './ast.ts';
 *
 * const nw = nowiki('[[not a link]]');
 * nw.value; // '[[not a link]]'
 * ```
 */
export function nowiki(value: string): Nowiki {
  return { type: 'nowiki', value };
}

/**
 * Create a {@linkcode Comment} node.
 *
 * @example HTML comment
 * ```ts
 * import { comment } from './ast.ts';
 *
 * const c = comment('hidden note');
 * c.value; // 'hidden note'
 * ```
 */
export function comment(value: string): Comment {
  return { type: 'comment', value };
}

/**
 * Create a {@linkcode Redirect} node.
 *
 * @example Page redirect
 * ```ts
 * import { redirect, wikilink } from './ast.ts';
 *
 * const r = redirect('Main Page', [wikilink('Main Page', [])]);
 * r.target; // 'Main Page'
 * ```
 */
export function redirect(target: string, children: WikistNode[]): Redirect {
  return { type: 'redirect', target, children };
}

/**
 * Create a {@linkcode Signature} node.
 *
 * @example Four-tilde signature (username + timestamp)
 * ```ts
 * import { signature } from './ast.ts';
 *
 * const sig = signature(4);
 * sig.tildes; // 4
 * ```
 */
export function signature(tildes: 3 | 4 | 5): Signature {
  return { type: 'signature', tildes };
}

/**
 * Create a {@linkcode Break} node (explicit `<br>` line break).
 *
 * Named `lineBreak` to avoid collision with the `break` reserved word.
 *
 * @example Line break
 * ```ts
 * import { lineBreak } from './ast.ts';
 *
 * const br = lineBreak();
 * br.type; // 'break'
 * ```
 */
export function lineBreak(): Break {
  // `lineBreak` is the exported name because `break` would collide with the
  // JavaScript keyword at call sites.
  return { type: 'break' };
}

/**
 * Create a {@linkcode Gallery} node.
 *
 * @example Gallery with attributes
 * ```ts
 * import { gallery, text } from './ast.ts';
 *
 * const g = gallery([text('File:A.png')], { mode: 'packed' });
 * g.attributes; // { mode: 'packed' }
 * ```
 */
export function gallery(
  children: WikistNode[],
  attributes?: Readonly<Record<string, string>>,
): Gallery {
  // Like htmlTag(), the gallery builder keeps optional attributes sparse so
  // tooling sees the same shape whether the tree came from parsing or manual
  // construction.
  return attributes !== undefined
    ? { type: 'gallery', attributes, children }
    : { type: 'gallery', children };
}

/**
 * Create a {@linkcode Reference} node.
 *
 * @example Named reference
 * ```ts
 * import { reference, text } from './ast.ts';
 *
 * const ref = reference([text('Source text.')], 'cite1', 'note');
 * ref.name;  // 'cite1'
 * ref.group; // 'note'
 * ```
 *
 * @example Anonymous reference
 * ```ts
 * import { reference, text } from './ast.ts';
 *
 * const ref = reference([text('Inline citation.')]);
 * ref.name; // undefined
 * ```
 */
export function reference(
  children: WikistNode[],
  name?: string,
  group?: string,
): Reference {
  // References have two independent optional metadata fields. Building the node
  // step by step keeps the runtime shape obvious and avoids attaching metadata
  // that the caller did not actually provide.
  const node: Reference = { type: 'reference', children };
  if (name !== undefined) {
    return group !== undefined
      ? { type: 'reference', name, group, children }
      : { type: 'reference', name, children };
  }
  return node;
}
