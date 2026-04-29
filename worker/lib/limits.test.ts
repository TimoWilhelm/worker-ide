import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';

import {
	ENTITLEMENT_ORG_MAX_MEMBERS,
	ENTITLEMENT_ORG_MAX_PROJECTS,
	ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_USER_MAX_FREE_ORGS,
} from '@shared/entitlements';
import {
	EFFECTIVE_LIMIT_ORG_MAX_MEMBERS,
	EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS,
	EFFECTIVE_LIMIT_ORG_MAX_PROJECTS,
	EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES,
	EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS,
} from '@shared/limits';

import { getEffectiveLimit } from './limits';
import * as schema from '../db/auth-schema';

const database = drizzle(env.DB, { schema });

beforeAll(async () => {
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "organization" (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, logo TEXT, created_at INTEGER NOT NULL, metadata TEXT, plan TEXT NOT NULL DEFAULT 'free', deleted_at INTEGER, banned_at INTEGER)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "project" (id TEXT PRIMARY KEY, name TEXT NOT NULL, durable_object_hex_id TEXT NOT NULL, organization_id TEXT NOT NULL, preview_visibility TEXT NOT NULL DEFAULT 'private', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, deleted_via_type TEXT, deleted_via_id TEXT, banned_at INTEGER, last_activity_at INTEGER NOT NULL)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "entitlement" (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, key TEXT NOT NULL, value_type TEXT NOT NULL, value TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
	);
});

function uniqueId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function insertOrganization(plan = 'free') {
	const organizationId = uniqueId('org');
	await database.insert(schema.organization).values({
		id: organizationId,
		name: organizationId,
		slug: organizationId,
		plan,
		createdAt: new Date(),
	});
	return organizationId;
}

async function insertProject(organizationId: string) {
	const projectId = uniqueId('project');
	const now = new Date();
	await database.insert(schema.project).values({
		id: projectId,
		name: projectId,
		durableObjectHexId: uniqueId('do'),
		organizationId,
		previewVisibility: 'private',
		createdAt: now,
		updatedAt: now,
		lastActivityAt: now,
	});
	return projectId;
}

async function insertEntitlement(scopeId: string, key: string, value: number) {
	await database.insert(schema.entitlement).values({
		id: uniqueId('entitlement'),
		scopeId,
		key,
		valueType: 'number',
		value: String(value),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
}

describe('getEffectiveLimit', () => {
	it('resolves the default user free organization cap', async () => {
		const userId = uniqueId('user');

		await expect(getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS, userId })).resolves.toBe(3);
	});

	it('resolves a user entitlement override', async () => {
		const userId = uniqueId('user');
		await insertEntitlement(userId, ENTITLEMENT_USER_MAX_FREE_ORGS, 7);
		await expect(getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS, userId })).resolves.toBe(7);
	});

	it('resolves the plan default for org pending invitation limits without an override key', async () => {
		const organizationId = await insertOrganization('pro');

		await expect(getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS, organizationId })).resolves.toBe(25);
	});

	it('resolves org project and member overrides independently', async () => {
		const organizationId = await insertOrganization('free');
		await insertEntitlement(organizationId, ENTITLEMENT_ORG_MAX_PROJECTS, 42);
		await insertEntitlement(organizationId, ENTITLEMENT_ORG_MAX_MEMBERS, 13);

		await expect(getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_ORG_MAX_PROJECTS, organizationId })).resolves.toBe(42);
		await expect(getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_ORG_MAX_MEMBERS, organizationId })).resolves.toBe(13);
	});

	it('resolves project storage quota with project override precedence', async () => {
		const organizationId = await insertOrganization('free');
		const projectId = await insertProject(organizationId);
		await insertEntitlement(organizationId, ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, 1000);
		await insertEntitlement(projectId, ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES, 2000);

		await expect(getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES, projectId })).resolves.toBe(2000);
	});

	it('falls back to the org storage override when no project override exists', async () => {
		const organizationId = await insertOrganization('free');
		const projectId = await insertProject(organizationId);
		await insertEntitlement(organizationId, ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, 1500);

		await expect(getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES, projectId })).resolves.toBe(1500);
	});
});
