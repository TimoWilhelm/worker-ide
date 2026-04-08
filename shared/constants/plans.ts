/**
 * Organization plan definitions and limits.
 *
 * Each organization has a `plan` field that determines its resource limits.
 * Users access resources through org membership.
 */

// =============================================================================
// Plan Types
// =============================================================================

export const PLAN_FREE = 'free';
export const PLAN_PRO = 'pro';
export const PLAN_ENTERPRISE = 'enterprise';

export type PlanId = typeof PLAN_FREE | typeof PLAN_PRO | typeof PLAN_ENTERPRISE;

// =============================================================================
// Plan Limits
// =============================================================================

export interface PlanLimits {
	maxProjects: number;
	maxMembers: number;
	maxPendingInvitations: number;
	monthlyCredits: number;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
	[PLAN_FREE]: {
		maxProjects: 10,
		maxMembers: 10,
		maxPendingInvitations: 10,
		monthlyCredits: 100,
	},
	[PLAN_PRO]: {
		maxProjects: 50,
		maxMembers: 25,
		maxPendingInvitations: 25,
		monthlyCredits: 1000,
	},
	[PLAN_ENTERPRISE]: {
		maxProjects: 500,
		maxMembers: 100,
		maxPendingInvitations: 100,
		monthlyCredits: 5000,
	},
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get the limits for a given plan.
 * Falls back to free plan limits for unknown plan values.
 */
export function getOrgLimits(plan: string): PlanLimits {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- plan string comes from DB, safe to cast after fallback
	return PLAN_LIMITS[plan as PlanId] ?? PLAN_LIMITS[PLAN_FREE];
}

/**
 * Number of AI credits consumed per agent session.
 */
export const CREDITS_PER_AI_SESSION = 1;
