import { getOrgLimits, getUserPlanLimits, PLAN_FREE } from './constants/plans';

import type { PlanLimits } from './constants/plans';

export type EntitlementValueType = 'number' | 'boolean' | 'string';

/**
 * A typed entitlement value. The discriminator `valueType` determines
 * how `value` (stored as TEXT in SQLite) is interpreted.
 */
export type EntitlementValue =
	| { valueType: 'number'; value: number }
	| { valueType: 'boolean'; value: boolean }
	| { valueType: 'string'; value: string };
export function serializeEntitlementValue(typed: EntitlementValue): string {
	return String(typed.value);
}
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

/**
 * Org-scoped entitlement keys.
 * Assigned to an organization to override its plan defaults.
 */
export const ENTITLEMENT_ORG_MAX_PROJECTS = 'org:max_projects' as const;
export const ENTITLEMENT_ORG_MAX_MEMBERS = 'org:max_members' as const;
export const ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES = 'org:storage_quota_bytes' as const;

/**
 * User-scoped entitlement keys.
 * Assigned to a user to override global defaults.
 */
export const ENTITLEMENT_USER_MAX_ORGANIZATIONS = 'user:max_organizations' as const;

/**
 * Project-scoped entitlement keys.
 * Assigned to a project (scopeId = projectId) to override org/plan defaults.
 */
export const ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES = 'project:storage_quota_bytes' as const;

export type OrgEntitlementKey =
	| typeof ENTITLEMENT_ORG_MAX_PROJECTS
	| typeof ENTITLEMENT_ORG_MAX_MEMBERS
	| typeof ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES;

export type UserEntitlementKey = typeof ENTITLEMENT_USER_MAX_ORGANIZATIONS;

export type ProjectEntitlementKey = typeof ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES;

export type EntitlementKey = OrgEntitlementKey | UserEntitlementKey | ProjectEntitlementKey;

/**
 * All valid entitlement keys with their expected value types.
 * Used for validation and documentation.
 */
export const ENTITLEMENT_REGISTRY: Record<EntitlementKey, { valueType: EntitlementValueType; description: string }> = {
	[ENTITLEMENT_ORG_MAX_PROJECTS]: { valueType: 'number', description: 'Maximum active projects per organization' },
	[ENTITLEMENT_ORG_MAX_MEMBERS]: { valueType: 'number', description: 'Maximum members per organization' },
	[ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES]: { valueType: 'number', description: 'Maximum object storage bytes per project (org default)' },
	[ENTITLEMENT_USER_MAX_ORGANIZATIONS]: { valueType: 'number', description: 'Maximum organizations a user can create' },
	[ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES]: {
		valueType: 'number',
		description: 'Maximum object storage bytes for this project (overrides org)',
	},
};

export function isValidEntitlementKey(key: string): key is EntitlementKey {
	return key in ENTITLEMENT_REGISTRY;
}
export function getEntitlementScope(key: EntitlementKey): 'org' | 'user' | 'project' {
	if (key.startsWith('org:')) return 'org';
	if (key.startsWith('project:')) return 'project';
	return 'user';
}
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
export interface ResolvedOrgLimits {
	maxProjects: number;
	maxMembers: number;
	maxPendingInvitations: number;
	storageQuotaBytes: number;
}
export interface ResolvedUserLimits {
	maxOrganizations: number;
}

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
function getNumber(map: Map<string, EntitlementValue>, key: string): number | undefined {
	const entry = map.get(key);
	if (entry?.valueType === 'number') {
		return entry.value;
	}
	return undefined;
}
export function resolveOrgLimits(plan: string, entitlements: Map<string, EntitlementValue>): ResolvedOrgLimits {
	const planLimits: PlanLimits = getOrgLimits(plan);

	return {
		maxProjects: getNumber(entitlements, ENTITLEMENT_ORG_MAX_PROJECTS) ?? planLimits.maxProjects,
		maxMembers: getNumber(entitlements, ENTITLEMENT_ORG_MAX_MEMBERS) ?? planLimits.maxMembers,
		maxPendingInvitations: planLimits.maxPendingInvitations,
		storageQuotaBytes: getNumber(entitlements, ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES) ?? planLimits.storageQuotaBytes,
	};
}
export function resolveUserLimits(plan: string, entitlements: Map<string, EntitlementValue>): ResolvedUserLimits {
	const planLimits = getUserPlanLimits(plan);

	return {
		maxOrganizations: getNumber(entitlements, ENTITLEMENT_USER_MAX_ORGANIZATIONS) ?? planLimits.maxOwnedOrganizations,
	};
}
export function resolveOrgLimitsFromRows(plan: string, rows: Array<{ key: string; valueType: string; value: string }>): ResolvedOrgLimits {
	return resolveOrgLimits(plan ?? PLAN_FREE, toEntitlementMap(rows));
}
export function resolveUserLimitsFromRows(
	plan: string,
	rows: Array<{ key: string; valueType: string; value: string }>,
): ResolvedUserLimits {
	return resolveUserLimits(plan ?? PLAN_FREE, toEntitlementMap(rows));
}

/**
 * Resolve the effective storage quota for a project.
 *
 * Resolution order: project entitlement override → org entitlement override → plan default.
 */
export function resolveProjectStorageQuota(
	plan: string,
	orgEntitlements: Map<string, EntitlementValue>,
	projectEntitlements: Map<string, EntitlementValue>,
): number {
	const projectOverride = getNumber(projectEntitlements, ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES);
	if (projectOverride !== undefined) return projectOverride;

	const orgOverride = getNumber(orgEntitlements, ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES);
	if (orgOverride !== undefined) return orgOverride;

	const planLimits: PlanLimits = getOrgLimits(plan);
	return planLimits.storageQuotaBytes;
}
export function resolveProjectStorageQuotaFromRows(
	plan: string,
	orgRows: Array<{ key: string; valueType: string; value: string }>,
	projectRows: Array<{ key: string; valueType: string; value: string }>,
): number {
	return resolveProjectStorageQuota(plan, toEntitlementMap(orgRows), toEntitlementMap(projectRows));
}
