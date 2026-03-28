/**
 * Shared notification types used by the push and email auxiliary workers
 * and the main worker for queue message schemas.
 */

export interface PushSubscriptionInfo {
	endpoint: string;
	key: string;
	auth: string;
}

export interface PushNotification {
	tag: string;
	title: string;
	body: string;
	path?: string;
	ttl?: number;
}

export interface PushQueueMessage {
	userId: string;
	tag: string;
	timestamp: number;
	title: string;
	body: string;
	path?: string;
	ttl?: number;
}

export interface EmailQueueMessage {
	from: string;
	to: string | string[];
	subject: string;
	html: string;
	replyTo?: string;
}
