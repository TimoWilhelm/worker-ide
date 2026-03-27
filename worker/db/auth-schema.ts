/**
 * Drizzle ORM schema for the D1 auth database.
 *
 * Contains:
 * - better-auth core tables (user, session, account, verification)
 * - better-auth organization plugin tables (organization, member, invitation)
 * - Custom project table linking projects to organizations
 *
 * This schema is used by drizzle-d1.config.ts for D1 migrations.
 * The table/column names follow better-auth's default conventions.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// =============================================================================
// better-auth Core Tables
// =============================================================================

export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const session = sqliteTable(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		token: text('token').notNull().unique(),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		activeOrganizationId: text('active_organization_id'),
	},
	(table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = sqliteTable(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
		refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
		scope: text('scope'),
		password: text('password'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [index('account_user_id_idx').on(table.userId), index('account_provider_account_idx').on(table.providerId, table.accountId)],
);

export const verification = sqliteTable(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }),
		updatedAt: integer('updated_at', { mode: 'timestamp' }),
	},
	(table) => [index('verification_identifier_idx').on(table.identifier)],
);

// =============================================================================
// better-auth Organization Plugin Tables
// =============================================================================

export const organization = sqliteTable('organization', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').unique(),
	logo: text('logo'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	metadata: text('metadata'),
});

export const member = sqliteTable(
	'member',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role').notNull().default('member'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [index('member_org_user_idx').on(table.organizationId, table.userId), index('member_user_id_idx').on(table.userId)],
);

export const invitation = sqliteTable(
	'invitation',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		email: text('email').notNull(),
		role: text('role'),
		status: text('status').notNull().default('pending'),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		inviterId: text('inviter_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
	},
	(table) => [index('invitation_org_id_idx').on(table.organizationId), index('invitation_email_idx').on(table.email)],
);

// =============================================================================
// Custom: Project Table
// =============================================================================

export const project = sqliteTable(
	'project',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		durableObjectHexId: text('durable_object_hex_id').notNull(),
		name: text('name').notNull(),
		humanId: text('human_id').notNull(),
		previewVisibility: text('preview_visibility').notNull().default('public'),
		createdByUserId: text('created_by_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
		deletedAt: integer('deleted_at', { mode: 'timestamp' }),
	},
	(table) => [
		index('project_org_deleted_idx').on(table.organizationId, table.deletedAt),
		index('project_deleted_created_idx').on(table.deletedAt, table.createdAt),
	],
);

// =============================================================================
// Inferred Types
// =============================================================================

export type UserRow = typeof user.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type OrganizationRow = typeof organization.$inferSelect;
export type MemberRow = typeof member.$inferSelect;
export type InvitationRow = typeof invitation.$inferSelect;
export type ProjectRow = typeof project.$inferSelect;
export type ProjectInsert = typeof project.$inferInsert;
