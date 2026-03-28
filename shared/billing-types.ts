/**
 * Billing type definitions shared between frontend and worker.
 *
 * These types define the billing data model for subscription management.
 * Billing is org-scoped — users access resources through org membership.
 *
 * Note: No Stripe integration yet. These types prepare the infrastructure
 * for when a payment provider is connected.
 */

// =============================================================================
// Subscription Types
// =============================================================================

/**
 * Possible states of an organization's subscription.
 */
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing';

/**
 * A subscription record linking an organization to a plan.
 */
export interface Subscription {
	id: string;
	organizationId: string;
	plan: string;
	status: SubscriptionStatus;
	currentPeriodStart?: number;
	currentPeriodEnd?: number;
	cancelAtPeriodEnd: boolean;
	/** External payment provider subscription ID (e.g. Stripe sub_xxx) */
	externalId?: string;
	/** External payment provider customer ID (e.g. Stripe cus_xxx) */
	externalCustomerId?: string;
	createdAt: number;
	updatedAt: number;
}

// =============================================================================
// Billing Event Types
// =============================================================================

/**
 * Types of billing events recorded in the audit log.
 */
export type BillingEventType =
	| 'subscription_created'
	| 'subscription_updated'
	| 'subscription_canceled'
	| 'invoice_paid'
	| 'invoice_failed';

/**
 * An immutable billing event for audit purposes.
 */
export interface BillingEvent {
	id: string;
	organizationId: string;
	type: BillingEventType;
	metadata?: string;
	createdAt: number;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a subscription status represents an active subscription
 * that should grant access to paid features.
 */
export function isActiveSubscription(status: SubscriptionStatus): boolean {
	return status === 'active' || status === 'trialing';
}
