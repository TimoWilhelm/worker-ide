export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing';
export interface Subscription {
	id: string;
	organizationId: string;
	plan: string;
	status: SubscriptionStatus;
	currentPeriodStart?: number;
	currentPeriodEnd?: number;
	cancelAtPeriodEnd: boolean;
	externalId?: string;
	externalCustomerId?: string;
	createdAt: number;
	updatedAt: number;
}
export type BillingEventType =
	| 'subscription_created'
	| 'subscription_updated'
	| 'subscription_canceled'
	| 'invoice_paid'
	| 'invoice_failed';
export interface BillingEvent {
	id: string;
	organizationId: string;
	type: BillingEventType;
	metadata?: string;
	createdAt: number;
}

/**
 * Check if a subscription status represents an active subscription
 * that should grant access to paid features.
 */
export function isActiveSubscription(status: SubscriptionStatus): boolean {
	return status === 'active' || status === 'trialing';
}
