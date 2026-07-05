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
	const enterSpan = tracing?.enterSpan?.bind(tracing);
	if (typeof enterSpan !== 'function') {
		return run(noopSpan);
	}
	return enterSpan(name, (span: TracingSpan) => {
		applyAttributes(span, attributes);
		return run(span);
	});
}
