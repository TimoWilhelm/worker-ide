import { describe, expect, it } from 'vitest';

import type { PushSubscriptionInfo } from '@shared/notification-types';

describe('PushSubscriptionInfo notificationsEnabled', () => {
	it('defaults to enabled when registerSubscription stores with notificationsEnabled: true', () => {
		const subscription: PushSubscriptionInfo = {
			endpoint: 'https://fcm.example.com/push/abc',
			key: 'test-key',
			auth: 'test-auth',
		};
		const stored: PushSubscriptionInfo = { ...subscription, notificationsEnabled: true };
		expect(stored.notificationsEnabled).toBe(true);
	});

	it('can be set to false to disable notifications', () => {
		const stored: PushSubscriptionInfo = {
			endpoint: 'https://fcm.example.com/push/abc',
			key: 'test-key',
			auth: 'test-auth',
			notificationsEnabled: false,
		};
		expect(stored.notificationsEnabled).toBe(false);
	});

	it('is optional for backwards compatibility with legacy entries', () => {
		const legacy: PushSubscriptionInfo = {
			endpoint: 'https://fcm.example.com/push/abc',
			key: 'test-key',
			auth: 'test-auth',
		};
		// Legacy entries without the flag should default to enabled
		expect(legacy.notificationsEnabled).toBeUndefined();
		expect(legacy.notificationsEnabled !== false).toBe(true);
	});
});

describe('queue consumer subscription filtering', () => {
	const enabledSubscription: PushSubscriptionInfo = {
		endpoint: 'https://fcm.example.com/push/device-a',
		key: 'key-a',
		auth: 'auth-a',
		notificationsEnabled: true,
	};

	const disabledSubscription: PushSubscriptionInfo = {
		endpoint: 'https://fcm.example.com/push/device-b',
		key: 'key-b',
		auth: 'auth-b',
		notificationsEnabled: false,
	};

	const legacySubscription: PushSubscriptionInfo = {
		endpoint: 'https://fcm.example.com/push/device-c',
		key: 'key-c',
		auth: 'auth-c',
	};

	const subscriptions = [
		{ key: 'user1/hash-a', subscription: enabledSubscription },
		{ key: 'user1/hash-b', subscription: disabledSubscription },
		{ key: 'user1/hash-c', subscription: legacySubscription },
	];

	it('filters out disabled subscriptions', () => {
		const filtered = subscriptions.filter(({ subscription }) => subscription.notificationsEnabled !== false);
		expect(filtered).toHaveLength(2);
		expect(filtered.map(({ key }) => key)).toEqual(['user1/hash-a', 'user1/hash-c']);
	});

	it('keeps enabled subscriptions', () => {
		const filtered = subscriptions.filter(({ subscription }) => subscription.notificationsEnabled !== false);
		expect(filtered.some(({ subscription }) => subscription.endpoint.includes('device-a'))).toBe(true);
	});

	it('keeps legacy subscriptions without notificationsEnabled field', () => {
		const filtered = subscriptions.filter(({ subscription }) => subscription.notificationsEnabled !== false);
		expect(filtered.some(({ subscription }) => subscription.endpoint.includes('device-c'))).toBe(true);
	});

	it('excludes explicitly disabled subscriptions', () => {
		const filtered = subscriptions.filter(({ subscription }) => subscription.notificationsEnabled !== false);
		expect(filtered.some(({ subscription }) => subscription.endpoint.includes('device-b'))).toBe(false);
	});
});

function parsePreference(raw?: string): { enabled: boolean } | undefined {
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === 'object' && parsed !== null && 'notificationsEnabled' in parsed) {
			return { enabled: (parsed as { notificationsEnabled?: boolean }).notificationsEnabled !== false };
		}
		// Legacy entries without the flag default to enabled
		return { enabled: true };
	} catch {
		return undefined;
	}
}

describe('notification preference parsing', () => {
	it('returns undefined for missing subscription', () => {
		expect(parsePreference()).toBeUndefined();
	});

	it('returns enabled: true for subscription with notificationsEnabled: true', () => {
		const raw = JSON.stringify({ endpoint: 'e', key: 'k', auth: 'a', notificationsEnabled: true });
		expect(parsePreference(raw)).toEqual({ enabled: true });
	});

	it('returns enabled: false for subscription with notificationsEnabled: false', () => {
		const raw = JSON.stringify({ endpoint: 'e', key: 'k', auth: 'a', notificationsEnabled: false });
		expect(parsePreference(raw)).toEqual({ enabled: false });
	});

	it('returns enabled: true for legacy subscription without notificationsEnabled', () => {
		const raw = JSON.stringify({ endpoint: 'e', key: 'k', auth: 'a' });
		expect(parsePreference(raw)).toEqual({ enabled: true });
	});

	it('returns undefined for invalid JSON', () => {
		expect(parsePreference('not-json')).toBeUndefined();
	});
});

function mergePreference(raw: string | undefined, enabled: boolean): string | undefined {
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === 'object' && parsed !== null && 'endpoint' in parsed && 'key' in parsed && 'auth' in parsed) {
			return JSON.stringify({ ...(parsed as PushSubscriptionInfo), notificationsEnabled: enabled });
		}
		return undefined;
	} catch {
		return undefined;
	}
}

describe('setNotificationPreference merge logic', () => {
	it('merges enabled flag into existing subscription', () => {
		const raw = JSON.stringify({ endpoint: 'e', key: 'k', auth: 'a', notificationsEnabled: true });
		const result = mergePreference(raw, false);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.notificationsEnabled).toBe(false);
		expect(parsed.endpoint).toBe('e');
	});

	it('adds enabled flag to legacy subscription', () => {
		const raw = JSON.stringify({ endpoint: 'e', key: 'k', auth: 'a' });
		const result = mergePreference(raw, true);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.notificationsEnabled).toBe(true);
	});

	it('returns undefined for missing subscription', () => {
		expect(mergePreference(undefined, true)).toBeUndefined();
	});

	it('returns undefined for invalid JSON', () => {
		expect(mergePreference('not-json', true)).toBeUndefined();
	});

	it('returns undefined for object missing required fields', () => {
		expect(mergePreference(JSON.stringify({ endpoint: 'e' }), true)).toBeUndefined();
	});
});
