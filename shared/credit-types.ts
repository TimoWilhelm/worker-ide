export type CreditTransactionType = 'grant' | 'purchase' | 'usage' | 'refund' | 'adjustment';
export interface CreditLedgerEntry {
	id: string;
	organizationId: string;
	amount: number;
	balance: number;
	type: CreditTransactionType;
	description: string;
	referenceId?: string;
	createdAt: number;
}
export interface CreditBalance {
	organizationId: string;
	balance: number;
	updatedAt: number;
}
