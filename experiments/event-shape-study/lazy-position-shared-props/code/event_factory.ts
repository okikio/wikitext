import type { TokenType } from './token.ts';
import type {
	EnterEvent,
	ExitEvent,
	Point,
	Position,
	TextEvent,
	TokenEvent,
} from './events.ts';

type LazyPositionEvent = {
	position: Position;
};

function defineLazyPosition<T extends object>(
	event: T,
	start: Point,
	end: Point,
): T & LazyPositionEvent {
	let position: Position | undefined;

	return Object.defineProperty(event, 'position', {
		enumerable: true,
		configurable: false,
		get(): Position {
			position ??= { start, end };
			return position;
		},
	}) as T & LazyPositionEvent;
}

/**
 * Create an eager enter event directly from source points.
 *
 * This keeps the public event surface unchanged while moving the nested
 * position-object allocation into one constructor path with a stable property
 * layout.
 */
export function enterEventFromPoints(
	node_type: string,
	props: Readonly<Record<string, unknown>>,
	start: Point,
	end: Point,
): EnterEvent {
	return defineLazyPosition({
		kind: 'enter',
		node_type,
		props,
	}, start, end);
}

/** Create an eager exit event directly from source points. */
export function exitEventFromPoints(
	node_type: string,
	start: Point,
	end: Point,
): ExitEvent {
	return defineLazyPosition({
		kind: 'exit',
		node_type,
	}, start, end);
}

/** Create an eager text event directly from source points. */
export function textEventFromPoints(
	start_offset: number,
	end_offset: number,
	start: Point,
	end: Point,
): TextEvent {
	return defineLazyPosition({
		kind: 'text',
		start_offset,
		end_offset,
	}, start, end);
}

/** Create an eager token event directly from source points. */
export function tokenEventFromPoints(
	token_type: TokenType,
	start_offset: number,
	end_offset: number,
	start: Point,
	end: Point,
): TokenEvent {
	return defineLazyPosition({
		kind: 'token',
		token_type,
		start_offset,
		end_offset,
	}, start, end);
}
