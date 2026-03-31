/**
 * Organization plan definitions and limits.
 *
 * Each organization has a `plan` field that determines its resource limits.
 * Billing is always org-scoped (like GitHub/Cloudflare) — users are never
 * billed directly, they access resources through org membership.
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
// Plan Display Info
// =============================================================================

export interface PlanDisplayInfo {
	name: string;
	description: string;
	priceMonthly: number;
	priceYearly: number;
	features: string[];
}

export const PLAN_DISPLAY: Record<PlanId, PlanDisplayInfo> = {
	[PLAN_FREE]: {
		name: 'Free',
		description: 'For personal projects and small teams.',
		priceMonthly: 0,
		priceYearly: 0,
		features: ['5 projects', '5 members', '100 AI credits/month'],
	},
	[PLAN_PRO]: {
		name: 'Pro',
		description: 'For growing teams with more projects and members.',
		priceMonthly: 20,
		priceYearly: 192,
		features: ['50 projects', '25 members', '1,000 AI credits/month', 'Priority support'],
	},
	[PLAN_ENTERPRISE]: {
		name: 'Enterprise',
		description: 'For large organizations with custom needs.',
		priceMonthly: 50,
		priceYearly: 480,
		features: ['500 projects', '100 members', '5,000 AI credits/month', 'Dedicated support', 'Custom integrations'],
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
 * Get the display info for a given plan.
 * Falls back to free plan display for unknown plan values.
 */
export function getPlanDisplay(plan: string): PlanDisplayInfo {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- plan string comes from DB, safe to cast after fallback
	return PLAN_DISPLAY[plan as PlanId] ?? PLAN_DISPLAY[PLAN_FREE];
}

/**
 * Number of AI credits consumed per agent session.
 */
export const CREDITS_PER_AI_SESSION = 1;
