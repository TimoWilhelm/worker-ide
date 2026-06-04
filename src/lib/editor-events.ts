import type { ServerError, ServerLogEntry } from '@shared/types';

/**
 * Typed editor-internal event bus.
 *
 * These events are dispatched on `globalThis` as `CustomEvent`s so that
 * loosely-coupled feature modules (log buffer, dependency error store,
 * preview panel, etc.) can react to coordinator/preview activity without
 * prop drilling. This module is the single typed surface for those events:
 * use `emitEditorEvent` / `onEditorEvent` instead of constructing
 * `CustomEvent`s by hand so payload shapes stay compile-time checked.
 */
export interface EditorEventMap {
	'server-error': ServerError;
	'server-logs': ServerLogEntry[];
	rebuild: undefined;
	'preview-refresh': undefined;
	'preview-force-refresh': undefined;
}

type EditorEventName = keyof EditorEventMap;

type EmitArguments<Name extends EditorEventName> = EditorEventMap[Name] extends undefined
	? [event: Name]
	: [event: Name, detail: EditorEventMap[Name]];

export function emitEditorEvent<Name extends EditorEventName>(...arguments_: EmitArguments<Name>): void {
	const [event, detail] = arguments_;
	globalThis.dispatchEvent(new CustomEvent(event, { detail }));
}

export function onEditorEvent<Name extends EditorEventName>(event: Name, handler: (detail: EditorEventMap[Name]) => void): () => void {
	const listener = (raw: Event) => {
		if (raw instanceof CustomEvent) {
			handler(raw.detail);
		}
	};
	globalThis.addEventListener(event, listener);
	return () => globalThis.removeEventListener(event, listener);
}
