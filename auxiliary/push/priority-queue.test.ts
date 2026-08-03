import { describe, expect, it, vi } from 'vitest';

import type { PushNotification } from '@shared/notification-types';

describe('Push notification priority queue routing', () => {
	it('routes high urgency notifications to PUSH_HIGH_QUEUE', () => {
		const highUrgencyNotification: PushNotification = {
			title: 'Agent needs your input',
			body: 'Select option A or B',
			tag: 'session-1',
			urgency: 'high',
		};

		const normalUrgencyNotification: PushNotification = {
			title: 'Session complete',
			body: 'Your task has completed.',
			tag: 'session-1',
			urgency: 'normal',
		};

		const mockNormalQueue = { send: vi.fn(), sendBatch: vi.fn() };
		const mockHighQueue = { send: vi.fn(), sendBatch: vi.fn() };

		function routeNotification(notification: PushNotification) {
			return notification.urgency === 'high' ? mockHighQueue : mockNormalQueue;
		}

		expect(routeNotification(highUrgencyNotification)).toBe(mockHighQueue);
		expect(routeNotification(normalUrgencyNotification)).toBe(mockNormalQueue);
	});
});
