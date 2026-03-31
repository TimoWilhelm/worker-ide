/**
 * Entitlements: plan-based limits with per-entity overrides.
 *
 * ## Naming Convention
 *
 * Each entitlement key follows the pattern `<scope>:<resource>` where:
 * - `scope` is `org` or `user`
 * - `resource` is a descriptive snake_case name (e.g. `max_projects`)
 *
 * This makes it easy to assign entitlements to the correct entity type
 * and to query all entitlements for a given scope.
 *
 * ## Value Types
 *
 * Entitlements support multiple value types stored in a single `value` TEXT
 * column using a `value_type` discriminator:
 * - `number`  — numeric limits (max projects, max members, etc.)
 * - `boolean` — feature flags (e.g. `org:custom_domains`)
 * - `string`  — arbitrary string values (e.g. `org:support_tier`)
 *
 * ## Resolution Order
 *
 * entitlement override → plan default.
 * If an entitlement row exists for a given key, it wins.
 * Otherwise, fall back to the plan's default for that limit.
 *
 * AI credits are intentionally NOT enforced — they remain display-only.
 */

import { getOrgLimits, PLAN_FREE } from './constants/plans';

import type { PlanLimits } from './constants/plans';

// =============================================================================
// Value Types
// =============================================================================

export type EntitlementValueType = 'number' | 'boolean' | 'string';

/**
 * A typed entitlement value. The discriminator `valueType` determines
 * how `value` (stored as TEXT in SQLite) is interpreted.
 */
export type EntitlementValue =
	| { valueType: 'number'; value: number }
	| { valueType: 'boolean'; value: boolean }
	| { valueType: 'string'; value: string };

/**
 * Serialize an entitlement value to a string for DB storage.
 */
export function serializeEntitlementValue(typed: EntitlementValue): string {
	return String(typed.value);
}

/**
 * Deserialize a DB string back to a typed entitlement value.
 */
export function deserializeEntitlementValue(raw: string, valueType: EntitlementValueType): EntitlementValue {
	switch (valueType) {
		case 'number': {
			return { valueType: 'number', value: Number(raw) };
		}
		case 'boolean': {
			return { valueType: 'boolean', value: raw === 'true' };
		}
		case 'string': {
			return { valueType: 'string', value: raw };
		}
	}
}

// =============================================================================
// Entitlement Keys
// =============================================================================

/**
 * Org-scoped entitlement keys.
 * Assigned to an organization to override its plan defaults.
 */
export const ENTITLEMENT_ORG_MAX_PROJECTS = 'org:max_projects' as const;
export const ENTITLEMENT_ORG_MAX_MEMBERS = 'org:max_members' as const;

/**
 * User-scoped entitlement keys.
 * Assigned to a user to override global defaults.
 */
export const ENTITLEMENT_USER_MAX_ORGANIZATIONS = 'user:max_organizations' as const;

export type OrgEntitlementKey = typeof ENTITLEMENT_ORG_MAX_PROJECTS | typeof ENTITLEMENT_ORG_MAX_MEMBERS;

export type UserEntitlementKey = typeof ENTITLEMENT_USER_MAX_ORGANIZATIONS;

export type EntitlementKey = OrgEntitlementKey | UserEntitlementKey;

/**
 * All valid entitlement keys with their expected value types.
 * Used for validation and documentation.
 */
export const ENTITLEMENT_REGISTRY: Record<EntitlementKey, { valueType: EntitlementValueType; description: string }> = {
	[ENTITLEMENT_ORG_MAX_PROJECTS]: { valueType: 'number', description: 'Maximum active projects per organization' },
	[ENTITLEMENT_ORG_MAX_MEMBERS]: { valueType: 'number', description: 'Maximum members per organization' },
	[ENTITLEMENT_USER_MAX_ORGANIZATIONS]: { valueType: 'number', description: 'Maximum organizations a user can create' },
};

export function isValidEntitlementKey(key: string): key is EntitlementKey {
	return key in ENTITLEMENT_REGISTRY;
}

/**
 * Extract the scope prefix from an entitlement key.
 */
export function getEntitlementScope(key: EntitlementKey): 'org' | 'user' {
	return key.startsWith('org:') ? 'org' : 'user';
}

// =============================================================================
// Entitlement Record (DB row shape)
// =============================================================================

/**
 * A single entitlement override stored in the database.
 */
export interface EntitlementRecord {
	id: string;
	scopeId: string;
	key: EntitlementKey;
	valueType: EntitlementValueType;
	value: string;
	note: string | undefined;
	createdAt: Date;
	updatedAt: Date;
}

// =============================================================================
// Resolved Limits
// =============================================================================

/**
 * Resolved org limits — the effective maximums after entitlement overrides.
 */
export interface ResolvedOrgLimits {
	maxProjects: number;
	maxMembers: number;
}

/**
 * Resolved user limits — the effective maximums after entitlement overrides.
 */
export interface ResolvedUserLimits {
	maxOrganizations: number;
}

/**
 * Default max organizations per user (not plan-scoped since billing is org-level).
 */
export const DEFAULT_MAX_ORGANIZATIONS = 5;

// =============================================================================
// Resolvers
// =============================================================================

/**
 * Build a lookup map from raw entitlement DB rows.
 * Only includes rows whose key/valueType match the registry.
 */
export function toEntitlementMap(rows: Array<{ key: string; valueType: string; value: string }>): Map<string, EntitlementValue> {
	const map = new Map<string, EntitlementValue>();
	for (const row of rows) {
		if (isValidEntitlementKey(row.key)) {
			const expectedType = ENTITLEMENT_REGISTRY[row.key].valueType;
			if (row.valueType === expectedType) {
				map.set(row.key, deserializeEntitlementValue(row.value, expectedType));
			}
		}
	}
	return map;
}

/**
 * Extract a numeric entitlement value from the map, or return undefined.
 */
function getNumber(map: Map<string, EntitlementValue>, key: string): number | undefined {
	const entry = map.get(key);
	if (entry?.valueType === 'number') {
		return entry.value;
	}
	return undefined;
}

/**
 * Resolve org limits from plan defaults + entitlement overrides.
 */
export function resolveOrgLimits(plan: string, entitlements: Map<string, EntitlementValue>): ResolvedOrgLimits {
	const planLimits: PlanLimits = getOrgLimits(plan);

	return {
		maxProjects: getNumber(entitlements, ENTITLEMENT_ORG_MAX_PROJECTS) ?? planLimits.maxProjects,
		maxMembers: getNumber(entitlements, ENTITLEMENT_ORG_MAX_MEMBERS) ?? planLimits.maxMembers,
	};
}

/**
 * Resolve user limits from defaults + entitlement overrides.
 */
export function resolveUserLimits(entitlements: Map<string, EntitlementValue>): ResolvedUserLimits {
	return {
		maxOrganizations: getNumber(entitlements, ENTITLEMENT_USER_MAX_ORGANIZATIONS) ?? DEFAULT_MAX_ORGANIZATIONS,
	};
}

/**
 * Convenience: resolve org limits directly from plan + raw DB rows.
 */
export function resolveOrgLimitsFromRows(plan: string, rows: Array<{ key: string; valueType: string; value: string }>): ResolvedOrgLimits {
	return resolveOrgLimits(plan ?? PLAN_FREE, toEntitlementMap(rows));
}

/**
 * Convenience: resolve user limits directly from raw DB rows.
 */
export function resolveUserLimitsFromRows(rows: Array<{ key: string; valueType: string; value: string }>): ResolvedUserLimits {
	return resolveUserLimits(toEntitlementMap(rows));
}
