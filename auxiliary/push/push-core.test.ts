import { describe, expect, it } from 'vitest';

import { resolveWebPushTopic } from './push-core';

describe('resolveWebPushTopic', () => {
	it('uses an explicit valid topic before the notification tag', () => {
		expect(
			resolveWebPushTopic({
				title: 'Title',
				body: 'Body',
				tag: 'fallback',
				topic: 'topic_123',
			}),
		).toBe('topic_123');
	});

	it('uses a valid notification tag when no topic is provided', () => {
		expect(resolveWebPushTopic({ title: 'Title', body: 'Body', tag: 'session-123' })).toBe('session-123');
	});

	it.each(['', 'contains spaces', 'a'.repeat(33)])('omits invalid topics without blocking delivery', (topic) => {
		expect(resolveWebPushTopic({ title: 'Title', body: 'Body', tag: 'fallback', topic })).toBeUndefined();
	});
});
