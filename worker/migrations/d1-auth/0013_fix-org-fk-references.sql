-- Fix stale FK references to `organization` after migration 0012 recreated the table.
-- SQLite DROP TABLE + RENAME breaks FK definitions in other tables that referenced it.
-- Rebuild each affected table so FKs point to the current `organization` table.

PRAGMA foreign_keys=OFF;--> statement-breakpoint

-- 1. member (user ↔ org association)
CREATE TABLE `__new_member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_member`("id", "organization_id", "user_id", "role", "created_at") SELECT "id", "organization_id", "user_id", "role", "created_at" FROM `member`;--> statement-breakpoint
DROP TABLE `member`;--> statement-breakpoint
ALTER TABLE `__new_member` RENAME TO `member`;--> statement-breakpoint
CREATE INDEX `member_org_user_idx` ON `member` (`organization_id`, `user_id`);--> statement-breakpoint
CREATE INDEX `member_user_id_idx` ON `member` (`user_id`);--> statement-breakpoint

-- 2. invitation
CREATE TABLE `__new_invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`inviter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_invitation`("id", "organization_id", "email", "role", "status", "expires_at", "inviter_id", "created_at") SELECT "id", "organization_id", "email", "role", "status", "expires_at", "inviter_id", "created_at" FROM `invitation`;--> statement-breakpoint
DROP TABLE `invitation`;--> statement-breakpoint
ALTER TABLE `__new_invitation` RENAME TO `invitation`;--> statement-breakpoint
CREATE INDEX `invitation_org_id_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint

-- 3. subscription
CREATE TABLE `__new_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_period_start` integer,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`external_id` text,
	`external_customer_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_subscription`("id", "organization_id", "plan", "status", "current_period_start", "current_period_end", "cancel_at_period_end", "external_id", "external_customer_id", "created_at", "updated_at") SELECT "id", "organization_id", "plan", "status", "current_period_start", "current_period_end", "cancel_at_period_end", "external_id", "external_customer_id", "created_at", "updated_at" FROM `subscription`;--> statement-breakpoint
DROP TABLE `subscription`;--> statement-breakpoint
ALTER TABLE `__new_subscription` RENAME TO `subscription`;--> statement-breakpoint
CREATE INDEX `subscription_org_id_idx` ON `subscription` (`organization_id`);--> statement-breakpoint
CREATE INDEX `subscription_external_id_idx` ON `subscription` (`external_id`);--> statement-breakpoint

-- 4. credit_ledger
CREATE TABLE `__new_credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`amount` integer NOT NULL,
	`balance` integer NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`reference_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_credit_ledger`("id", "organization_id", "amount", "balance", "type", "description", "reference_id", "created_at") SELECT "id", "organization_id", "amount", "balance", "type", "description", "reference_id", "created_at" FROM `credit_ledger`;--> statement-breakpoint
DROP TABLE `credit_ledger`;--> statement-breakpoint
ALTER TABLE `__new_credit_ledger` RENAME TO `credit_ledger`;--> statement-breakpoint
CREATE INDEX `credit_ledger_org_id_idx` ON `credit_ledger` (`organization_id`);--> statement-breakpoint
CREATE INDEX `credit_ledger_type_idx` ON `credit_ledger` (`type`);--> statement-breakpoint
CREATE INDEX `credit_ledger_reference_idx` ON `credit_ledger` (`reference_id`);--> statement-breakpoint

PRAGMA foreign_keys=ON;
