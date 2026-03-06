/**
 * # @okikio/wikitext
 *
 * Event-stream-first wikitext source parser for Deno and npm.
 *
 * This entrypoint re-exports all public APIs:
 *
 * - **{@linkcode TextSource}**: abstraction over the backing text store
 *   (plain string, rope, CRDT)
 * - **{@linkcode Token}** and **{@linkcode TokenType}**: the tokenizer's
 *   output vocabulary
 * - **{@linkcode WikitextEvent}** and variants: the event stream model
 *   (enter, exit, text, token, error)
 * - **{@linkcode WikistNode}** and family: the full AST node model,
 *   type guards, and builder functions
 * - **{@linkcode tokenize}**: generator-based tokenizer over TextSource
 * - **{@linkcode blockEvents}**: block-level parser yielding structural events
 *
 * As more modules are implemented (block/inline parsers, tree builder,
 * stringifier, filter utilities), they will be re-exported from this
 * same entrypoint.
 *
 * @example Importing core types
 * ```ts
 * import type { TextSource, Token, WikitextEvent, WikistNode } from '@okikio/wikitext';
 * import { TokenType, tokenize } from '@okikio/wikitext';
 * ```
 *
 * @example Building a simple wikist tree
 * ```ts
 * import { root, heading, text } from '@okikio/wikitext';
 *
 * const tree = root([heading(2, [text('Hello world')])]);
 * ```
 *
 * @module
 */

// Re-export all public APIs from each module.
// All exports are re-exported verbatim — no wrapping, no filtering.
export * from './text_source.ts';
export * from './token.ts';
export * from './events.ts';
export * from './ast.ts';
export * from './tokenizer.ts';
export * from './block_parser.ts';
