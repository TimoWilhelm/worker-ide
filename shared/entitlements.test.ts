import { describe, expect, it } from 'vitest';

import {
	ENTITLEMENT_USER_MAX_ORGANIZATIONS,
	ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES,
	getEntitlementScope,
	resolveOrgLimits,
	resolveProjectStorageQuota,
	resolveUserLimits,
	toEntitlementMap,
} from './entitlements';

describe('getEntitlementScope', () => {
	it('returns "org" for org-scoped keys', () => {
		expect(getEntitlementScope('org:max_projects')).toBe('org');
		expect(getEntitlementScope('org:storage_quota_bytes')).toBe('org');
	});

	it('returns "user" for user-scoped keys', () => {
		expect(getEntitlementScope('user:max_organizations')).toBe('user');
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
	it('uses the user plan defaults for owned organization count', () => {
		expect(resolveUserLimits('free', toEntitlementMap([])).maxOrganizations).toBe(1);
		expect(resolveUserLimits('pro', toEntitlementMap([])).maxOrganizations).toBe(5);
		expect(resolveUserLimits('enterprise', toEntitlementMap([])).maxOrganizations).toBe(50);
	});

	it('lets user entitlements override the plan default', () => {
		const entitlements = toEntitlementMap([{ key: ENTITLEMENT_USER_MAX_ORGANIZATIONS, valueType: 'number', value: '3' }]);

		expect(resolveUserLimits('free', entitlements).maxOrganizations).toBe(3);
	});
});
