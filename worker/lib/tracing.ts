import { AsyncLocalStorage } from 'node:async_hooks';

import { tracing } from 'cloudflare:workers';

export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Record<string, SpanAttributeValue | undefined>;

export interface TracingSpan {
	setAttribute(key: string, value: SpanAttributeValue): void;
	readonly isTraced?: boolean;
}

const noopSpan: TracingSpan = {
	setAttribute() {},
	isTraced: false,
};

/**
 * Fallback tracing handle for execution contexts where the module-level
 * `cloudflare:workers` `tracing` global is not bound.
 *
 * The global is only active inside "handler" invocations (fetch, scheduled,
 * queue). An RPC method on a `WorkerEntrypoint` (e.g. the `VITE_HOST.build`
 * call the preview Durable Object makes into the `vite-host` worker) is not a
 * handler invocation, so `tracing` is `undefined` there and every `withSpan`
 * would silently drop to a no-op — the whole ~30s build became an untraced
 * black box. An RPC entrypoint calls {@link runWithTracing} with its
 * `ctx.tracing` handle so nested `withSpan` calls deep in the build still
 * record spans and nest correctly under the invocation.
 */
const tracingContext = new AsyncLocalStorage<Tracing | undefined>();

/**
 * Establish an explicit tracing handle for the duration of `function_`, so any
 * nested {@link withSpan} calls record spans even when the `cloudflare:workers`
 * `tracing` global is not bound (RPC entrypoint methods). Pass `ctx.tracing`
 * from the entrypoint. A no-op when the handle is `undefined`.
 */
export function runWithTracing<R>(handle: Tracing | undefined, function_: () => R): R {
	if (handle === undefined) {
		return function_();
	}
	return tracingContext.run(handle, function_);
}

/** The active tracing handle: the global when bound, else the context fallback. */
function activeTracing(): Tracing | undefined {
	return tracing ?? tracingContext.getStore();
}

function applyAttributes(span: TracingSpan, attributes?: SpanAttributes): void {
	if (attributes === undefined) {
		return;
	}
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== undefined) {
			span.setAttribute(key, value);
		}
	}
}

export async function withSpan<T>(name: string, run: (span: TracingSpan) => T | Promise<T>, attributes?: SpanAttributes): Promise<T> {
	const handle = activeTracing();
	const enterSpan = handle?.enterSpan?.bind(handle);
	if (typeof enterSpan !== 'function') {
		return run(noopSpan);
	}
	return enterSpan(name, (span: TracingSpan) => {
		applyAttributes(span, attributes);
		return run(span);
	});
}
