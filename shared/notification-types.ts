export interface PushSubscriptionInfo {
	endpoint: string;
	key: string;
	auth: string;
	notificationsEnabled?: boolean;
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
