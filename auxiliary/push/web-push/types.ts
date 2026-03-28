export interface SubscriptionInfo {
	endpoint: string;
	key: string;
	auth: string;
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface WebPushMessage {
	data: string;
	urgency: Urgency;
	sub: string;
	ttl: number;
}

export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };
export type ApplicationServerKeys = WithRequired<JsonWebKey, 'x' | 'y'>;
