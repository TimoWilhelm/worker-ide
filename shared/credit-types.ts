/**
 * AI credit type definitions shared between frontend and worker.
 *
 * Credits are org-scoped and tracked via an append-only ledger.
 * Positive amounts are credits (grants, purchases, refunds),
 * negative amounts are debits (AI usage).
 *
 * Note: Credits are not enforced yet. These types prepare the
 * infrastructure for usage-based billing.
 */

// =============================================================================
// Credit Transaction Types
// =============================================================================

/**
 * Types of credit transactions in the ledger.
 */
export type CreditTransactionType = 'grant' | 'purchase' | 'usage' | 'refund' | 'adjustment';

/**
 * A single entry in the credit ledger.
 */
export interface CreditLedgerEntry {
	id: string;
	organizationId: string;
	/** Positive = credit added, negative = credit consumed */
	amount: number;
	/** Running balance after this transaction */
	balance: number;
	type: CreditTransactionType;
	description: string;
	/** Optional reference to the resource that triggered this entry (e.g. AI session ID) */
	referenceId?: string;
	createdAt: number;
}

/**
 * Summary of an organization's credit balance.
 */
export interface CreditBalance {
	organizationId: string;
	balance: number;
	updatedAt: number;
}
