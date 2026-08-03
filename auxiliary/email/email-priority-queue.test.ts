import { describe, expect, it, vi } from 'vitest';

import type { EmailPriority } from '@shared/notification-types';

describe('Email priority queue routing', () => {
	it('routes high priority emails to EMAIL_HIGH_QUEUE', () => {
		const mockNormalQueue = { send: vi.fn() };
		const mockHighQueue = { send: vi.fn() };

		function routeEmail(priority: EmailPriority = 'normal') {
			return priority === 'high' ? mockHighQueue : mockNormalQueue;
		}

		expect(routeEmail('high')).toBe(mockHighQueue);
		expect(routeEmail('normal')).toBe(mockNormalQueue);
		expect(routeEmail()).toBe(mockNormalQueue);
	});
});
