import type { PushUrgency } from '@shared/notification-types';

export interface SubscriptionInfo {
	endpoint: string;
	key: string;
	auth: string;
}

export type { PushUrgency } from '@shared/notification-types';

export interface WebPushMessage {
	data: string;
	urgency: PushUrgency;
	sub: string;
	ttl: number;
	topic?: string;
}

export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };
export type ApplicationServerKeys = WithRequired<JsonWebKey, 'x' | 'y'>;
