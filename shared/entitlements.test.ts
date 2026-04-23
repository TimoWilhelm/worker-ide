import { describe, expect, it } from 'vitest';

import {
	DEFAULT_MAX_FREE_ORGS,
	ENTITLEMENT_USER_MAX_FREE_ORGS,
	ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES,
	getEntitlementScope,
	resolveOrgLimits,
	resolveProjectStorageQuota,
	resolveUserLimits,
	resolveUserLimitsFromRows,
	toEntitlementMap,
} from './entitlements';

describe('getEntitlementScope', () => {
	it('returns "org" for org-scoped keys', () => {
		expect(getEntitlementScope('org:max_projects')).toBe('org');
		expect(getEntitlementScope('org:storage_quota_bytes')).toBe('org');
	});

	it('returns "user" for user-scoped keys', () => {
		expect(getEntitlementScope('user:max_free_orgs')).toBe('user');
	});

	it('returns "project" for project-scoped keys', () => {
		expect(getEntitlementScope('project:storage_quota_bytes')).toBe('project');
	});
});

describe('resolveProjectStorageQuota', () => {
	const FREE_DEFAULT = 50 * 1024 * 1024; // 50 MB
	const PRO_DEFAULT = 500 * 1024 * 1024; // 500 MB

	it('returns plan default when no entitlements exist', () => {
		const orgEntitlements = toEntitlementMap([]);
		const projectEntitlements = toEntitlementMap([]);

		expect(resolveProjectStorageQuota('free', orgEntitlements, projectEntitlements)).toBe(FREE_DEFAULT);
		expect(resolveProjectStorageQuota('pro', orgEntitlements, projectEntitlements)).toBe(PRO_DEFAULT);
	});

	it('returns org entitlement override when set', () => {
		const orgEntitlements = toEntitlementMap([{ key: ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, valueType: 'number', value: '100000000' }]);
		const projectEntitlements = toEntitlementMap([]);

		expect(resolveProjectStorageQuota('free', orgEntitlements, projectEntitlements)).toBe(100_000_000);
	});

	it('returns project entitlement override when set, even if org override exists', () => {
		const orgEntitlements = toEntitlementMap([{ key: ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, valueType: 'number', value: '100000000' }]);
		const projectEntitlements = toEntitlementMap([
			{ key: ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES, valueType: 'number', value: '200000000' },
		]);

		expect(resolveProjectStorageQuota('free', orgEntitlements, projectEntitlements)).toBe(200_000_000);
	});

	it('project entitlement overrides plan default even without org entitlement', () => {
		const orgEntitlements = toEntitlementMap([]);
		const projectEntitlements = toEntitlementMap([{ key: ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES, valueType: 'number', value: '999' }]);

		expect(resolveProjectStorageQuota('enterprise', orgEntitlements, projectEntitlements)).toBe(999);
	});

	it('falls back to free plan for unknown plan strings', () => {
		const orgEntitlements = toEntitlementMap([]);
		const projectEntitlements = toEntitlementMap([]);

		expect(resolveProjectStorageQuota('nonexistent', orgEntitlements, projectEntitlements)).toBe(FREE_DEFAULT);
	});
});

describe('resolveOrgLimits', () => {
	it('includes plan-based pending invitation limits', () => {
		const limits = resolveOrgLimits('free', toEntitlementMap([]));

		expect(limits.maxMembers).toBe(10);
		expect(limits.maxPendingInvitations).toBe(10);
	});
});

describe('resolveUserLimits', () => {
	it('uses the default free organization cap', () => {
		expect(resolveUserLimits(toEntitlementMap([])).maxFreeOrganizations).toBe(DEFAULT_MAX_FREE_ORGS);
	});

	it('lets user entitlements override the plan default', () => {
		const entitlements = toEntitlementMap([{ key: ENTITLEMENT_USER_MAX_FREE_ORGS, valueType: 'number', value: '5' }]);

		expect(resolveUserLimits(entitlements).maxFreeOrganizations).toBe(5);
	});

	it('ignores rows with the wrong value type', () => {
		const entitlements = toEntitlementMap([{ key: ENTITLEMENT_USER_MAX_FREE_ORGS, valueType: 'string', value: '5' }]);

		expect(resolveUserLimits(entitlements).maxFreeOrganizations).toBe(DEFAULT_MAX_FREE_ORGS);
	});

	it('resolves limits from entitlement rows', () => {
		expect(resolveUserLimitsFromRows([])).toEqual({ maxFreeOrganizations: DEFAULT_MAX_FREE_ORGS });
		expect(resolveUserLimitsFromRows([{ key: ENTITLEMENT_USER_MAX_FREE_ORGS, valueType: 'number', value: '4' }])).toEqual({
			maxFreeOrganizations: 4,
		});
	});
});
