import { describe, expect, it } from 'vitest';

import { runWithTracing, withSpan } from './tracing';

describe('withSpan', () => {
	it('returns the callback result', async () => {
		const result = await withSpan('test.sync', () => 42);
		expect(result).toBe(42);
	});

	it('awaits an async callback result', async () => {
		const result = await withSpan('test.async', async () => {
			await Promise.resolve();
			return 'done';
		});
		expect(result).toBe('done');
	});

	it('propagates thrown errors', async () => {
		await expect(
			withSpan('test.throw', () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
	});

	it('propagates rejected promises', async () => {
		await expect(withSpan('test.reject', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
	});

	it('exposes a span with setAttribute to the callback', async () => {
		const result = await withSpan(
			'test.attributes',
			(span) => {
				span.setAttribute('extra', 'value');
				return true;
			},
			{ 'test.number': 1, 'test.string': 'x', 'test.bool': true, 'test.skipped': undefined },
		);
		expect(result).toBe(true);
	});
});

describe('runWithTracing', () => {
	class FakeSpan {
		get isTraced(): boolean {
			return true;
		}
		setAttribute(): void {}
	}

	function fakeTracing(recorded: string[]): Tracing {
		return {
			enterSpan(name, callback, ...arguments_) {
				recorded.push(name);
				return callback(new FakeSpan(), ...arguments_);
			},
			Span: FakeSpan,
		};
	}

	it('runs the function and returns its result with an undefined handle', async () => {
		const result = await runWithTracing(undefined, () => withSpan('test.noop', () => 7));
		expect(result).toBe(7);
	});

	it('records nested withSpan calls via the provided handle (RPC entrypoint context)', async () => {
		const recorded: string[] = [];
		const result = await runWithTracing(fakeTracing(recorded), () => withSpan('outer', () => withSpan('inner', () => 'ok')));
		expect(result).toBe('ok');
		expect(recorded).toStrictEqual(['outer', 'inner']);
	});
});
