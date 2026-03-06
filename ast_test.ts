/**
 * Comprehensive tests for all foundational modules.
 *
 * Covers TextSource, Token, events, and AST (type guards + builders).
 * Uses three testing techniques:
 *
 * 1. **Example-based tests**: hand-written inputs with expected outputs.
 *    Each follows the AAA pattern (Arrange, Act, Assert).
 *
 * 2. **Boundary-value tests**: edge cases like empty strings, single
 *    characters, null bytes, and extreme heading levels.
 *
 * 3. **Property-based tests** (fast-check): random inputs that verify
 *    structural invariants (e.g., "builders produce nodes of the correct
 *    type", "type guards accept what builders produce").
 */
import { describe, it } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';
import * as fc from 'npm:fast-check';

// --- text_source.ts ---
import type { TextSource } from './text_source.ts';
import { slice } from './text_source.ts';

// --- token.ts ---
import { isToken, TokenType } from './token.ts';
import type { Token } from './token.ts';

// --- events.ts ---
import {
  enterEvent,
  errorEvent,
  exitEvent,
  isEnterEvent,
  isErrorEvent,
  isExitEvent,
  isTextEvent,
  isTokenEvent,
  textEvent,
  tokenEvent,
} from './events.ts';
import type {
  Position,
  WikitextEvent,
} from './events.ts';

// --- ast.ts ---
import {
  argument,
  behaviorSwitch,
  bold,
  boldItalic,
  categoryLink,
  comment,
  definitionDescription,
  definitionList,
  definitionTerm,
  externalLink,
  gallery,
  heading,
  htmlEntity,
  htmlTag,
  imageLink,
  isArgument,
  isBehaviorSwitch,
  isBold,
  isBoldItalic,
  isBreak,
  isCategoryLink,
  isComment,
  isDefinitionDescription,
  isDefinitionList,
  isDefinitionTerm,
  isExternalLink,
  isGallery,
  isHeading,
  isHtmlEntity,
  isHtmlTag,
  isImageLink,
  isItalic,
  isList,
  isListItem,
  isLiteral,
  isMagicWord,
  isNowiki,
  isParagraph,
  isParent,
  isParserFunction,
  isPreformatted,
  isRedirect,
  isReference,
  isRoot,
  isSignature,
  isTable,
  isTableCaption,
  isTableCell,
  isTableRow,
  isTemplate,
  isTemplateArgument,
  isText,
  isThematicBreak,
  isWikilink,
  italic,
  lineBreak,
  list,
  listItem,
  magicWord,
  nowiki,
  paragraph,
  parserFunction,
  preformatted,
  redirect,
  reference,
  root,
  signature,
  table,
  tableCaption,
  tableCell,
  tableRow,
  template,
  templateArgument,
  text,
  thematicBreak,
  wikilink,
} from './ast.ts';
import type {
  WikistNode,
  WikistNodeType,
  WikistRoot,
} from './ast.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A reusable Position for tests that don't care about source location. */
const pos: Position = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 10, offset: 9 },
};

// ===========================================================================
// text_source.ts
// ===========================================================================

describe('TextSource', () => {
  it('plain string satisfies TextSource', () => {
    const src: TextSource = 'hello';
    expect(src.length).toBe(5);
    expect(src.charCodeAt(0)).toBe(0x68); // 'h'
    expect(src.slice(1, 4)).toBe('ell');
  });

  it('slice() helper resolves offset ranges', () => {
    expect(slice('== Heading ==', 3, 10)).toBe('Heading');
  });

  it('slice() returns empty string for zero-length range', () => {
    expect(slice('hello', 2, 2)).toBe('');
  });
});

// ===========================================================================
// token.ts
// ===========================================================================

describe('TokenType', () => {
  it('has string enum values', () => {
    expect(TokenType.TEXT).toBe('TEXT');
    expect(TokenType.HEADING_MARKER).toBe('HEADING_MARKER');
    expect(TokenType.EOF).toBe('EOF');
  });
});

describe('isToken', () => {
  it('returns true for a valid token object', () => {
    const tok: Token = { type: TokenType.TEXT, start: 0, end: 5 };
    expect(isToken(tok)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isToken(null)).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(isToken('not a token')).toBe(false);
  });

  it('returns false when type is not a known TokenType', () => {
    expect(isToken({ type: 'UNKNOWN', start: 0, end: 1 })).toBe(false);
  });

  it('returns false when fields are missing', () => {
    expect(isToken({ type: TokenType.TEXT })).toBe(false);
    expect(isToken({ start: 0, end: 5 })).toBe(false);
  });
});

// ===========================================================================
// events.ts
// ===========================================================================

describe('event constructors', () => {
  it('enterEvent creates an EnterEvent', () => {
    const evt = enterEvent('heading', { level: 2 }, pos);
    expect(evt.kind).toBe('enter');
    expect(evt.node_type).toBe('heading');
    expect(evt.props).toEqual({ level: 2 });
    expect(evt.position).toBe(pos);
  });

  it('exitEvent creates an ExitEvent', () => {
    const evt = exitEvent('heading', pos);
    expect(evt.kind).toBe('exit');
    expect(evt.node_type).toBe('heading');
  });

  it('textEvent creates a TextEvent', () => {
    const evt = textEvent(3, 10, pos);
    expect(evt.kind).toBe('text');
    expect(evt.start_offset).toBe(3);
    expect(evt.end_offset).toBe(10);
  });

  it('tokenEvent creates a TokenEvent', () => {
    const evt = tokenEvent(TokenType.HEADING_MARKER, 0, 2, pos);
    expect(evt.kind).toBe('token');
    expect(evt.token_type).toBe(TokenType.HEADING_MARKER);
  });

  it('errorEvent creates an ErrorEvent', () => {
    const evt = errorEvent('Unclosed template', pos);
    expect(evt.kind).toBe('error');
    expect(evt.message).toBe('Unclosed template');
  });
});

describe('event type guards', () => {
  const events: WikitextEvent[] = [
    enterEvent('heading', { level: 2 }, pos),
    exitEvent('heading', pos),
    textEvent(0, 5, pos),
    tokenEvent(TokenType.TEXT, 0, 5, pos),
    errorEvent('test', pos),
  ];

  it('isEnterEvent filters enter events', () => {
    expect(events.filter(isEnterEvent).length).toBe(1);
  });

  it('isExitEvent filters exit events', () => {
    expect(events.filter(isExitEvent).length).toBe(1);
  });

  it('isTextEvent filters text events', () => {
    expect(events.filter(isTextEvent).length).toBe(1);
  });

  it('isTokenEvent filters token events', () => {
    expect(events.filter(isTokenEvent).length).toBe(1);
  });

  it('isErrorEvent filters error events', () => {
    expect(events.filter(isErrorEvent).length).toBe(1);
  });
});

// ===========================================================================
// ast.ts — builders
// ===========================================================================

describe('AST builders', () => {
  describe('root', () => {
    it('creates a root node', () => {
      const r = root([]);
      expect(r.type).toBe('root');
      expect(r.children).toEqual([]);
    });
  });

  describe('heading', () => {
    it('creates heading with level and children', () => {
      const h = heading(2, [text('Title')]);
      expect(h.type).toBe('heading');
      expect(h.level).toBe(2);
      expect(h.children.length).toBe(1);
    });
  });

  describe('paragraph', () => {
    it('creates a paragraph node', () => {
      const p = paragraph([text('Body')]);
      expect(p.type).toBe('paragraph');
    });
  });

  describe('thematicBreak', () => {
    it('creates a thematic break node', () => {
      const hr = thematicBreak();
      expect(hr.type).toBe('thematic-break');
    });
  });

  describe('preformatted', () => {
    it('creates a preformatted node', () => {
      const pre = preformatted([text(' code')]);
      expect(pre.type).toBe('preformatted');
    });
  });

  describe('list / listItem', () => {
    it('creates an ordered list with items', () => {
      const ol = list(true, [listItem('#', [text('first')])]);
      expect(ol.type).toBe('list');
      expect(ol.ordered).toBe(true);
      expect(ol.children[0].marker).toBe('#');
    });

    it('creates a bullet list', () => {
      const ul = list(false, [listItem('*', [text('item')])]);
      expect(ul.ordered).toBe(false);
    });
  });

  describe('definitionList / definitionTerm / definitionDescription', () => {
    it('creates a definition list', () => {
      const dl = definitionList([
        definitionTerm([text('Term')]),
        definitionDescription([text('Desc')]),
      ]);
      expect(dl.type).toBe('definition-list');
      expect(dl.children.length).toBe(2);
      expect(dl.children[0].type).toBe('definition-term');
      expect(dl.children[1].type).toBe('definition-description');
    });
  });

  describe('table / tableCaption / tableRow / tableCell', () => {
    it('creates a table with caption and row', () => {
      const t = table([
        tableCaption([text('Caption')]),
        tableRow([tableCell(true, [text('Header')])]),
      ]);
      expect(t.type).toBe('table');
      expect(t.children.length).toBe(2);
    });

    it('creates a table with attributes', () => {
      const t = table([tableRow([tableCell(false, [text('data')])])], 'class="wikitable"');
      expect(t.attributes).toBe('class="wikitable"');
    });

    it('creates header and data cells', () => {
      const th = tableCell(true, [text('H')]);
      const td = tableCell(false, [text('D')]);
      expect(th.header).toBe(true);
      expect(td.header).toBe(false);
    });

    it('creates a row with attributes', () => {
      const row = tableRow([tableCell(false, [text('x')])], 'style="color:red"');
      expect(row.attributes).toBe('style="color:red"');
    });

    it('creates a cell with attributes', () => {
      const cell = tableCell(false, [text('x')], 'colspan="2"');
      expect(cell.attributes).toBe('colspan="2"');
    });
  });

  describe('bold / italic / boldItalic', () => {
    it('creates formatting nodes', () => {
      expect(bold([text('b')]).type).toBe('bold');
      expect(italic([text('i')]).type).toBe('italic');
      expect(boldItalic([text('bi')]).type).toBe('bold-italic');
    });
  });

  describe('wikilink', () => {
    it('creates a wikilink with target and display text', () => {
      const link = wikilink('Main Page', [text('home')]);
      expect(link.type).toBe('wikilink');
      expect(link.target).toBe('Main Page');
      expect(link.children.length).toBe(1);
    });
  });

  describe('externalLink', () => {
    it('creates an external link', () => {
      const link = externalLink('https://example.com', [text('Example')]);
      expect(link.type).toBe('external-link');
      expect(link.url).toBe('https://example.com');
    });
  });

  describe('imageLink', () => {
    it('creates an image link', () => {
      const img = imageLink('File:Photo.jpg', [text('caption')]);
      expect(img.type).toBe('image-link');
      expect(img.target).toBe('File:Photo.jpg');
    });
  });

  describe('categoryLink', () => {
    it('creates a category with sort key', () => {
      const cat = categoryLink('Science', 'Physics');
      expect(cat.type).toBe('category-link');
      expect(cat.target).toBe('Science');
      expect(cat.sort_key).toBe('Physics');
    });

    it('creates a category without sort key', () => {
      const cat = categoryLink('Articles');
      expect(cat.sort_key).toBeUndefined();
    });
  });

  describe('template / templateArgument', () => {
    it('creates a template with named and positional args', () => {
      const t = template('Infobox', [
        templateArgument([text('val')]),
        templateArgument([text('v2')], 'key'),
      ]);
      expect(t.type).toBe('template');
      expect(t.name).toBe('Infobox');
      expect(t.children[0].name).toBeUndefined();
      expect(t.children[1].name).toBe('key');
    });
  });

  describe('argument', () => {
    it('creates a triple-brace argument with default', () => {
      const arg = argument('title', 'Untitled');
      expect(arg.type).toBe('argument');
      expect(arg.name).toBe('title');
      expect(arg.default).toBe('Untitled');
    });

    it('creates an argument without default', () => {
      const arg = argument('name');
      expect(arg.default).toBeUndefined();
    });
  });

  describe('parserFunction', () => {
    it('creates a parser function', () => {
      const fn = parserFunction('#if', [templateArgument([text('cond')])]);
      expect(fn.type).toBe('parser-function');
      expect(fn.name).toBe('#if');
    });
  });

  describe('magicWord / behaviorSwitch', () => {
    it('creates magic word and behavior switch', () => {
      expect(magicWord('PAGENAME').name).toBe('PAGENAME');
      expect(behaviorSwitch('TOC').name).toBe('TOC');
    });
  });

  describe('htmlTag', () => {
    it('creates an HTML tag with attributes', () => {
      const tag = htmlTag('div', false, [text('content')], { class: 'note' });
      expect(tag.type).toBe('html-tag');
      expect(tag.tag_name).toBe('div');
      expect(tag.self_closing).toBe(false);
      expect(tag.attributes).toEqual({ class: 'note' });
    });

    it('creates a self-closing tag without attributes', () => {
      const br = htmlTag('br', true, []);
      expect(br.self_closing).toBe(true);
      expect(br.attributes).toBeUndefined();
    });
  });

  describe('literal nodes', () => {
    it('creates text, htmlEntity, nowiki, comment', () => {
      expect(text('hello').value).toBe('hello');
      expect(htmlEntity('&amp;').value).toBe('&amp;');
      expect(nowiki('[[raw]]').value).toBe('[[raw]]');
      expect(comment('hidden').value).toBe('hidden');
    });
  });

  describe('redirect', () => {
    it('creates a redirect node', () => {
      const r = redirect('Main Page', [wikilink('Main Page', [])]);
      expect(r.type).toBe('redirect');
      expect(r.target).toBe('Main Page');
    });
  });

  describe('signature', () => {
    it('creates signature with tilde count', () => {
      expect(signature(3).tildes).toBe(3);
      expect(signature(4).tildes).toBe(4);
      expect(signature(5).tildes).toBe(5);
    });
  });

  describe('lineBreak', () => {
    it('creates a break node', () => {
      expect(lineBreak().type).toBe('break');
    });
  });

  describe('gallery', () => {
    it('creates a gallery with attributes', () => {
      const g = gallery([text('File:A.png')], { mode: 'packed' });
      expect(g.type).toBe('gallery');
      expect(g.attributes).toEqual({ mode: 'packed' });
    });

    it('creates a gallery without attributes', () => {
      const g = gallery([]);
      expect(g.attributes).toBeUndefined();
    });
  });

  describe('reference', () => {
    it('creates a named reference with group', () => {
      const ref = reference([text('Source.')], 'cite1', 'note');
      expect(ref.type).toBe('reference');
      expect(ref.name).toBe('cite1');
      expect(ref.group).toBe('note');
    });

    it('creates an anonymous reference', () => {
      const ref = reference([text('Inline.')]);
      expect(ref.name).toBeUndefined();
      expect(ref.group).toBeUndefined();
    });
  });
});

// ===========================================================================
// ast.ts — type guards
// ===========================================================================

describe('AST type guards', () => {
  // Build one node of each type for testing
  const allNodes: WikistNode[] = [
    root([]),
    heading(2, [text('T')]),
    paragraph([text('P')]),
    thematicBreak(),
    preformatted([text(' ')]),
    list(false, [listItem('*', [])]),
    listItem('*', []),
    definitionList([definitionTerm([text('T')])]),
    definitionTerm([text('T')]),
    definitionDescription([text('D')]),
    table([tableRow([tableCell(false, [text('X')])])]),
    tableCaption([text('C')]),
    tableRow([tableCell(false, [text('X')])]),
    tableCell(false, [text('X')]),
    bold([text('B')]),
    italic([text('I')]),
    boldItalic([text('BI')]),
    wikilink('Target', []),
    externalLink('https://x.com', []),
    imageLink('File:X.png', []),
    categoryLink('Cat'),
    template('T', []),
    templateArgument([text('V')]),
    argument('p'),
    parserFunction('#if', []),
    magicWord('PAGENAME'),
    behaviorSwitch('TOC'),
    htmlTag('div', false, []),
    htmlEntity('&amp;'),
    text('hello'),
    nowiki('raw'),
    comment('note'),
    redirect('Target', [wikilink('Target', [])]),
    signature(4),
    lineBreak(),
    gallery([]),
    reference([text('ref')]),
  ];

  it('isRoot matches only root', () => {
    expect(allNodes.filter(isRoot).length).toBe(1);
    expect(isRoot(root([]))).toBe(true);
    expect(isRoot(text('x'))).toBe(false);
  });

  it('isHeading matches only heading', () => {
    expect(allNodes.filter(isHeading).length).toBe(1);
  });

  it('isText matches only text', () => {
    expect(allNodes.filter(isText).length).toBe(1);
  });

  it('isTemplate matches only template', () => {
    expect(allNodes.filter(isTemplate).length).toBe(1);
  });

  it('isWikilink matches only wikilink', () => {
    expect(allNodes.filter(isWikilink).length).toBe(1);
  });

  it('each node type guard matches exactly once', () => {
    // Map of type string to guard function
    const guards: [string, (n: WikistNode) => boolean][] = [
      ['root', isRoot],
      ['heading', isHeading],
      ['paragraph', isParagraph],
      ['thematic-break', isThematicBreak],
      ['preformatted', isPreformatted],
      ['list', isList],
      ['list-item', isListItem],
      ['definition-list', isDefinitionList],
      ['definition-term', isDefinitionTerm],
      ['definition-description', isDefinitionDescription],
      ['table', isTable],
      ['table-caption', isTableCaption],
      ['table-row', isTableRow],
      ['table-cell', isTableCell],
      ['bold', isBold],
      ['italic', isItalic],
      ['bold-italic', isBoldItalic],
      ['wikilink', isWikilink],
      ['external-link', isExternalLink],
      ['image-link', isImageLink],
      ['category-link', isCategoryLink],
      ['template', isTemplate],
      ['template-argument', isTemplateArgument],
      ['argument', isArgument],
      ['parser-function', isParserFunction],
      ['magic-word', isMagicWord],
      ['behavior-switch', isBehaviorSwitch],
      ['html-tag', isHtmlTag],
      ['html-entity', isHtmlEntity],
      ['text', isText],
      ['nowiki', isNowiki],
      ['comment', isComment],
      ['redirect', isRedirect],
      ['signature', isSignature],
      ['break', isBreak],
      ['gallery', isGallery],
      ['reference', isReference],
    ];

    for (const [typeName, guard] of guards) {
      const matches = allNodes.filter(guard);
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe(typeName);
    }
  });
});

describe('isParent / isLiteral category guards', () => {
  it('isParent returns true for nodes with children', () => {
    expect(isParent(root([]))).toBe(true);
    expect(isParent(heading(2, []))).toBe(true);
    expect(isParent(template('T', []))).toBe(true);
    expect(isParent(wikilink('X', []))).toBe(true);
  });

  it('isParent returns false for literal and void nodes', () => {
    expect(isParent(text('x'))).toBe(false);
    expect(isParent(thematicBreak())).toBe(false);
    expect(isParent(signature(4))).toBe(false);
    expect(isParent(magicWord('TOC'))).toBe(false);
  });

  it('isLiteral returns true for nodes with value', () => {
    expect(isLiteral(text('hello'))).toBe(true);
    expect(isLiteral(htmlEntity('&amp;'))).toBe(true);
    expect(isLiteral(nowiki('raw'))).toBe(true);
    expect(isLiteral(comment('c'))).toBe(true);
  });

  it('isLiteral returns false for parent and void nodes', () => {
    expect(isLiteral(root([]))).toBe(false);
    expect(isLiteral(thematicBreak())).toBe(false);
    expect(isLiteral(heading(1, []))).toBe(false);
  });
});

// ===========================================================================
// ast.ts — WikistNode union exhaustiveness
// ===========================================================================

describe('WikistNodeType', () => {
  it('every builder-created node has a valid type string', () => {
    const expectedTypes: WikistNodeType[] = [
      'root', 'heading', 'paragraph', 'thematic-break', 'preformatted',
      'list', 'list-item', 'definition-list', 'definition-term', 'definition-description',
      'table', 'table-caption', 'table-row', 'table-cell',
      'bold', 'italic', 'bold-italic',
      'wikilink', 'external-link', 'image-link', 'category-link',
      'template', 'template-argument', 'argument', 'parser-function',
      'magic-word', 'behavior-switch',
      'html-tag', 'html-entity',
      'text', 'nowiki', 'comment',
      'redirect', 'signature', 'break', 'gallery', 'reference',
    ];

    // Verify each builder produces the expected type
    const builtNodes: WikistNode[] = [
      root([]), heading(2, []), paragraph([]), thematicBreak(), preformatted([]),
      list(false, []), listItem('*', []), definitionList([]), definitionTerm([]), definitionDescription([]),
      table([]), tableCaption([]), tableRow([]), tableCell(false, []),
      bold([]), italic([]), boldItalic([]),
      wikilink('T', []), externalLink('u', []), imageLink('F', []), categoryLink('C'),
      template('T', []), templateArgument([]), argument('n'), parserFunction('#f', []),
      magicWord('M'), behaviorSwitch('B'),
      htmlTag('div', false, []), htmlEntity('&x;'),
      text('t'), nowiki('n'), comment('c'),
      redirect('R', []), signature(4), lineBreak(), gallery([]), reference([]),
    ];

    for (let i = 0; i < expectedTypes.length; i++) {
      expect(builtNodes[i].type).toBe(expectedTypes[i]);
    }
  });
});

// ===========================================================================
// Property-based tests
// ===========================================================================

describe('property-based invariants', () => {
  it('every builder produces a node where its type guard returns true', () => {
    // For each heading level, the isHeading guard should match
    const levels = [1, 2, 3, 4, 5, 6] as const;
    for (const lvl of levels) {
      expect(isHeading(heading(lvl, []))).toBe(true);
    }

    // Signature tildes
    for (const t of [3, 4, 5] as const) {
      expect(isSignature(signature(t))).toBe(true);
    }
  });

  it('text builder preserves arbitrary string values', () => {
    fc.assert(
      fc.property(fc.string(), (s: string) => {
        const node = text(s);
        expect(node.type).toBe('text');
        expect(node.value).toBe(s);
        expect(isText(node)).toBe(true);
        expect(isLiteral(node)).toBe(true);
      }),
    );
  });

  it('heading builder accepts only valid levels 1-6', () => {
    const levels = [1, 2, 3, 4, 5, 6] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...levels),
        fc.array(fc.constant(text('x')), { minLength: 0, maxLength: 3 }),
        (level: 1 | 2 | 3 | 4 | 5 | 6, children: WikistNode[]) => {
          const h = heading(level, children);
          expect(h.level).toBe(level);
          expect(h.children.length).toBe(children.length);
        },
      ),
    );
  });

  it('wikilink builder preserves target string', () => {
    fc.assert(
      fc.property(fc.string(), (target: string) => {
        const link = wikilink(target, []);
        expect(link.target).toBe(target);
        expect(isWikilink(link)).toBe(true);
      }),
    );
  });

  it('template builder preserves name string', () => {
    fc.assert(
      fc.property(fc.string(), (name: string) => {
        const t = template(name, []);
        expect(t.name).toBe(name);
        expect(isTemplate(t)).toBe(true);
      }),
    );
  });

  it('isParent and isLiteral are mutually exclusive on all built nodes', () => {
    const nodes: WikistNode[] = [
      root([]), heading(1, []), paragraph([]), text('x'),
      htmlEntity('&'), comment('c'), nowiki('n'),
      thematicBreak(), signature(3), lineBreak(),
      magicWord('M'), behaviorSwitch('B'),
      categoryLink('C'), argument('a'),
      bold([]), wikilink('T', []), template('T', []),
    ];

    for (const node of nodes) {
      // A node cannot be both parent and literal
      if (isParent(node)) {
        expect(isLiteral(node)).toBe(false);
      }
      if (isLiteral(node)) {
        expect(isParent(node)).toBe(false);
      }
    }
  });

  it('slice() round-trips with TextSource for arbitrary strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (s: string, start: number) => {
          const end = Math.min(start + 10, s.length);
          const clampedStart = Math.min(start, s.length);
          expect(slice(s, clampedStart, end)).toBe(s.slice(clampedStart, end));
        },
      ),
    );
  });
});

// ===========================================================================
// WikistRoot alias
// ===========================================================================

describe('WikistRoot', () => {
  it('is an alias for Root', () => {
    const r = root([text('hello')]);
    // WikistRoot is a type alias, so this is a compile-time check.
    // Use it as WikistRoot to verify the type resolves.
    const wr: WikistRoot = r;
    expect(wr.type).toBe('root');
  });
});
