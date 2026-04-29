import { describe, expect, it } from 'vitest';

import { getEntitlementScope } from './entitlements';

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
