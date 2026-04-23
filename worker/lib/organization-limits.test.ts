import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';

import { ENTITLEMENT_USER_MAX_FREE_ORGS } from '@shared/entitlements';

import { shouldBlockOrganizationCreate } from './organization-limits';
import * as schema from '../db/auth-schema';

const database = drizzle(env.DB);

beforeAll(async () => {
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, banned_at INTEGER, role TEXT NOT NULL DEFAULT 'user', banned INTEGER DEFAULT 0, ban_reason TEXT, ban_expires INTEGER)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "organization" (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, logo TEXT, created_at INTEGER NOT NULL, metadata TEXT, plan TEXT NOT NULL DEFAULT 'free', deleted_at INTEGER, banned_at INTEGER)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "member" (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "entitlement" (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, key TEXT NOT NULL, value_type TEXT NOT NULL, value TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
	);
});

function uniqueId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function insertUser() {
	const now = new Date();
	const userId = uniqueId('user');
	await database.insert(schema.user).values({
		id: userId,
		name: 'Test User',
		email: `${userId}@example.com`,
		emailVerified: false,
		createdAt: now,
		updatedAt: now,
	});
	return userId;
}

async function insertOrganization(plan = 'free', deletedAt?: Date) {
	const organizationId = uniqueId('org');
	await database.insert(schema.organization).values({
		id: organizationId,
		name: organizationId,
		slug: organizationId,
		plan,
		createdAt: new Date(),
		deletedAt,
	});
	return organizationId;
}

async function addMembership(userId: string, organizationId: string, role: string) {
	await database.insert(schema.member).values({
		id: uniqueId('member'),
		organizationId,
		userId,
		role,
		createdAt: new Date(),
	});
}

async function addOwnedOrganization(userId: string, plan = 'free', deletedAt?: Date) {
	const organizationId = await insertOrganization(plan, deletedAt);
	await addMembership(userId, organizationId, 'owner');
	return organizationId;
}

async function addOrganizationMembership(userId: string, role: string, plan = 'free', deletedAt?: Date) {
	const organizationId = await insertOrganization(plan, deletedAt);
	await addMembership(userId, organizationId, role);
	return organizationId;
}

async function addUserEntitlement(userId: string, value: number) {
	await database.insert(schema.entitlement).values({
		id: uniqueId('entitlement'),
		scopeId: userId,
		key: ENTITLEMENT_USER_MAX_FREE_ORGS,
		valueType: 'number',
		value: String(value),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return userId;
}

describe('shouldBlockOrganizationCreate', () => {
	it('allows a free user with no owned organizations', async () => {
		const userId = await insertUser();

		await expect(shouldBlockOrganizationCreate(database, userId)).resolves.toBe(false);
	});

	it('allows a user below the default free organization cap', async () => {
		const userId = await insertUser();
		await addOrganizationMembership(userId, 'member');
		await addOwnedOrganization(userId);

		await expect(shouldBlockOrganizationCreate(database, userId)).resolves.toBe(false);
	});

	it('blocks once the user belongs to three free organizations', async () => {
		const userId = await insertUser();
		for (let index = 0; index < 3; index += 1) {
			await addOrganizationMembership(userId, 'member');
		}

		await expect(shouldBlockOrganizationCreate(database, userId)).resolves.toBe(true);
	});

	it('does not count non-free organizations toward the cap', async () => {
		const userId = await insertUser();
		for (let index = 0; index < 5; index += 1) {
			await addOrganizationMembership(userId, 'member', 'pro');
		}

		await expect(shouldBlockOrganizationCreate(database, userId)).resolves.toBe(false);
	});

	it('ignores deleted free organizations', async () => {
		const userId = await insertUser();
		await addOrganizationMembership(userId, 'member');
		await addOrganizationMembership(userId, 'admin');
		await addOrganizationMembership(userId, 'member', 'free', new Date());

		await expect(shouldBlockOrganizationCreate(database, userId)).resolves.toBe(false);
	});

	it('counts free organizations for any membership role', async () => {
		const userId = await insertUser();
		await addOwnedOrganization(userId);
		await addOrganizationMembership(userId, 'admin');
		await addOrganizationMembership(userId, 'member');

		await expect(shouldBlockOrganizationCreate(database, userId)).resolves.toBe(true);
	});

	it('lets the free organization entitlement raise the cap', async () => {
		const userId = await insertUser();
		await addUserEntitlement(userId, 5);
		for (let index = 0; index < 4; index += 1) {
			await addOrganizationMembership(userId, 'member');
		}

		await expect(shouldBlockOrganizationCreate(database, userId)).resolves.toBe(false);
	});

	it('blocks immediately when the free organization entitlement is zero', async () => {
		const userId = await insertUser();
		await addUserEntitlement(userId, 0);

		await expect(shouldBlockOrganizationCreate(database, userId)).resolves.toBe(true);
	});
});
