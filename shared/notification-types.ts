import type { ProjectDeepLinkTarget } from './project-deep-link';

export interface PushSubscriptionInfo {
	endpoint: string;
	key: string;
	auth: string;
	notificationsEnabled?: boolean;
}

export interface PushProjectDeepLink {
	projectId: string;
	target: ProjectDeepLinkTarget;
}

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface PushPayload {
	title: string;
	body: string;
	tag: string;
	path?: string;
	deepLink?: PushProjectDeepLink;
	data?: Record<string, unknown>;
}

export interface PushOptions {
	urgency?: PushUrgency;
	ttl?: number;
	topic?: string;
}

export interface PushNotification extends PushPayload, PushOptions {}

export interface PushQueueMessage {
	userId: string;
	notification: PushNotification;
	timestamp: number;
}

export type EmailPriority = 'normal' | 'high';

export interface EmailQueueMessage {
	from: string;
	to: string | string[];
	subject: string;
	html: string;
	replyTo?: string;
	priority?: EmailPriority;
}
