// deno-lint-ignore-file no-import-prefix no-unversioned-import

import * as fc from 'npm:fast-check';

/** Generate strings biased toward general wikitext syntax. */
export function wikiish_string(max_length = 200): fc.Arbitrary<string> {
	// This generator is intentionally syntax-heavy. The goal is not to mimic
	// real articles perfectly, but to hit delimiter and recovery paths far more
	// often than fc.string() would on its own.
	return fc.array(
		fc.constantFrom(
			'=', '*', '#', ';', ':', '|', '!', '-', ' ', '\n', '\r',
			'{', '}', '[', ']', '<', '>', '&', "'", '~', '_',
			'a', 'b', 'c', '1', '2', '+', '/',
		),
		{ minLength: 0, maxLength: max_length },
	).map((chars) => chars.join(''));
}

/** Generate strings biased toward inline wikitext syntax. */
export function inlineish_string(max_length = 200): fc.Arbitrary<string> {
	// Inline parsing bugs usually live where short delimiter runs overlap:
	// links, templates, entities, tags, apostrophes, and signatures. Biasing
	// toward those characters gives much better failure discovery than generic
	// prose-heavy fuzzing.
	return fc.array(
		fc.constantFrom(
			'[', ']', '{', '}', '<', '>', '&', '=', '|', ':', '/', '!', '-', '_', '~', "'",
			' ', '\n', '\r',
			'a', 'b', 'c', 'x', 'y', 'z', '0', '1', '2', '#', '+', '`',
		),
		{ minLength: 0, maxLength: max_length },
	).map((chars) => chars.join(''));
}

/**
 * Generate inputs that make spacing part of the syntax decision.
 *
 * These cases are useful because this parser has several boundaries where a
 * single leading space, tab, or newline changes whether a marker is block
 * syntax, inline syntax, or ordinary text.
 */
export function spacing_heavy_wikitext_string(max_chunks = 80): fc.Arbitrary<string> {
	// The chunks here intentionally crowd delimiters with spaces, tabs, and line
	// breaks so we can stress the exact places where line-start and trimming
	// rules matter.
	const chunk = fc.oneof(
		fc.constant(' '),
		fc.constant('  '),
		fc.constant('\t'),
		fc.constant('\n'),
		fc.constant('\r\n'),
		fc.constant(' == Heading =='),
		fc.constant('==  Heading  =='),
		fc.constant('* item'),
		fc.constant('*  item'),
		fc.constant('\t== Not heading =='),
		fc.constant(' {| class="wikitable"'),
		fc.constant('{| class="wikitable"'),
		fc.constant('[[  Main Page  |  label  ]]'),
		fc.constant('[ https://example.com label]'),
		fc.constant('[https://example.com\tlabel]'),
		fc.constant('{{  Card  | name = value }}'),
		fc.constant('<span class = "lead">'),
		fc.constant('</span>'),
		fc.constant('plain text'),
		fc.string({ minLength: 0, maxLength: 6 }),
	);

	return fc.array(chunk, { minLength: 0, maxLength: max_chunks })
		.map((chunks) => chunks.join(''));
}

/**
 * Generate mostly valid wikitext chunks interleaved with unusual Unicode.
 *
 * The point is not to define what every odd code point should mean. The point
 * is to make sure unusual payload text does not collapse otherwise valid wiki
 * structure or break recovery when delimiters remain intact.
 */
export function odd_character_wikitext_string(max_chunks = 60): fc.Arbitrary<string> {
	// These characters cover common parser trouble spots: zero-width marks,
	// combining accents, non-breaking spaces, bidi text, emoji, and a BOM-like
	// code point. They are odd enough to shake out assumptions without turning
	// the input into random binary noise.
	const odd = fc.constantFrom(
		'\u00A0',
		'\u200B',
		'\u200C',
		'\u200D',
		'\u2060',
		'\uFEFF',
		'\u0301',
		'\u0323',
		'\u05D0',
		'\u0627',
		'\u2603',
		'\u{1F9EA}',
	);
	const valid_chunk = fc.constantFrom(
		'== Heading ==',
		'* Item',
		'[[Main Page|home]]',
		'[https://example.com label]',
		'{{Card|name=value}}',
		'{{{title|Untitled}}}',
		'__TOC__',
		"''italic''",
		'<span class="lead">ok</span>',
		'<ref name="n">note</ref>',
		'&amp;',
		'plain text',
		'\n',
	);

	return fc.array(fc.oneof(valid_chunk, odd), { minLength: 0, maxLength: max_chunks })
		.map((chunks) => chunks.join(''));
}

/**
 * Generate adversarial strings that intentionally mix valid and invalid
 * delimiter patterns.
 */
export function pathological_wikitext_string(max_chunks = 80): fc.Arbitrary<string> {
	// These chunks are chosen to create awkward boundaries: half-open tags,
	// mismatched closers, markdown-like fences, table markers, and delimiter
	// soup. The expectation is not pretty output, only that parser contracts
	// still hold under hostile input.
	const chunk = fc.oneof(
		fc.constant('[['),
		fc.constant(']]'),
		fc.constant('{{'),
		fc.constant('}}'),
		fc.constant('{{{'),
		fc.constant('}}}'),
		fc.constant('<ref name="n">'),
		fc.constant('</ref>'),
		fc.constant('<nowiki>'),
		fc.constant('</nowiki>'),
		fc.constant('<span class="x">'),
		fc.constant('</span>'),
		fc.constant('<!--'),
		fc.constant('-->'),
		fc.constant('&amp;'),
		fc.constant('&broken'),
		fc.constant('__TOC__'),
		fc.constant('__BROKEN_'),
		fc.constant("''"),
		fc.constant("'''"),
		fc.constant("'''''"),
		fc.constant('~~~~'),
		fc.constant('```md\n'),
		fc.constant('```\n'),
		fc.constant('* '),
		fc.constant('# '),
		fc.constant(': '),
		fc.constant('; '),
		fc.constant('{|\n'),
		fc.constant('|-\n'),
		fc.constant('|}\n'),
		fc.constant('|'),
		fc.constant('||'),
		fc.constant('!!'),
		fc.constant('\n'),
		fc.constant('\r\n'),
		fc.constant(' '),
		fc.string({ minLength: 0, maxLength: 8 }),
	);

	return fc.array(chunk, { minLength: 0, maxLength: max_chunks })
		.map((chunks) => chunks.join(''));
}