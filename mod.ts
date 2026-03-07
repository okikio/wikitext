/**
 * Public entry point for `@okikio/wikitext`.
 *
 * This package is built as an event-stream-first wikitext parser. The raw
 * token stream is the cheapest layer. The event stream adds structure. The
 * tree model gives callers a normal nested object graph when they want one.
 *
 * This file simply re-exports the public surface so callers can import from one
 * place instead of remembering each source file.
 *
 * Today that public surface includes:
 *
 * - `TextSource` for the parser's input shape
 * - `Token` and `TokenType` for raw tokenizer output
 * - `WikitextEvent` and related helpers for the event stream
 * - `WikistNode` types, type guards, and builders for the tree model
 * - `tokenize()` for raw scanning
 * - `blockEvents()` for block-level structure
 *
 * As more features land, this entry point is where they will be re-exported.
 *
 * @example Importing the current public API
 * ```ts
 * import type { TextSource, Token, WikitextEvent, WikistNode } from '@okikio/wikitext';
 * import { TokenType, tokenize, blockEvents } from '@okikio/wikitext';
 * ```
 *
 * @module
 */

// Re-export the public surface exactly as defined in each module.
// There is no wrapper layer here.
export * from './text_source.ts';
export * from './token.ts';
export * from './events.ts';
export * from './ast.ts';
export * from './tokenizer.ts';
export * from './block_parser.ts';
