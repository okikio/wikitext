import type { TokenType } from './token.ts';
import type {
	EnterEvent,
	ExitEvent,
	Point,
	Position,
	TextEvent,
	TokenEvent,
} from './events.ts';

function positionFromPoints(start: Point, end: Point): Position {
	return { start, end };
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
	return {
		kind: 'enter',
		node_type,
		props,
		position: positionFromPoints(start, end),
	};
}

/** Create an eager exit event directly from source points. */
export function exitEventFromPoints(
	node_type: string,
	start: Point,
	end: Point,
): ExitEvent {
	return {
		kind: 'exit',
		node_type,
		position: positionFromPoints(start, end),
	};
}

/** Create an eager text event directly from source points. */
export function textEventFromPoints(
	start_offset: number,
	end_offset: number,
	start: Point,
	end: Point,
): TextEvent {
	return {
		kind: 'text',
		start_offset,
		end_offset,
		position: positionFromPoints(start, end),
	};
}

/** Create an eager token event directly from source points. */
export function tokenEventFromPoints(
	token_type: TokenType,
	start_offset: number,
	end_offset: number,
	start: Point,
	end: Point,
): TokenEvent {
	return {
		kind: 'token',
		token_type,
		start_offset,
		end_offset,
		position: positionFromPoints(start, end),
	};
}
