PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`inviter_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_invitation`("id", "organization_id", "email", "role", "status", "expires_at", "inviter_id", "created_at") SELECT "id", "organization_id", "email", "role", "status", "expires_at", "inviter_id", "created_at" FROM `invitation`;--> statement-breakpoint
DROP TABLE `invitation`;--> statement-breakpoint
ALTER TABLE `__new_invitation` RENAME TO `invitation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `invitation_org_id_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE TABLE `__new_project` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`durable_object_hex_id` text NOT NULL,
	`name` text NOT NULL,
	`preview_visibility` text DEFAULT 'public' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`banned_at` integer,
	`last_activity_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_project`("id", "organization_id", "durable_object_hex_id", "name", "preview_visibility", "created_at", "updated_at", "deleted_at", "banned_at", "last_activity_at") SELECT "id", "organization_id", "durable_object_hex_id", "name", "preview_visibility", "created_at", "updated_at", "deleted_at", "banned_at", "last_activity_at" FROM `project`;--> statement-breakpoint
DROP TABLE `project`;--> statement-breakpoint
ALTER TABLE `__new_project` RENAME TO `project`;--> statement-breakpoint
CREATE INDEX `project_org_deleted_idx` ON `project` (`organization_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `project_deleted_created_idx` ON `project` (`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `project_banned_idx` ON `project` (`banned_at`);--> statement-breakpoint
CREATE INDEX `project_last_activity_idx` ON `project` (`last_activity_at`);--> statement-breakpoint
CREATE TABLE `__new_project_transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_organization_id` text NOT NULL,
	`target_organization_id` text NOT NULL,
	`initiated_by_user_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by_user_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initiated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_project_transfer`("id", "project_id", "source_organization_id", "target_organization_id", "initiated_by_user_id", "status", "created_at", "resolved_at", "resolved_by_user_id") SELECT "id", "project_id", "source_organization_id", "target_organization_id", "initiated_by_user_id", "status", "created_at", "resolved_at", "resolved_by_user_id" FROM `project_transfer`;--> statement-breakpoint
DROP TABLE `project_transfer`;--> statement-breakpoint
ALTER TABLE `__new_project_transfer` RENAME TO `project_transfer`;--> statement-breakpoint
CREATE INDEX `project_transfer_status_target_idx` ON `project_transfer` (`status`,`target_organization_id`);--> statement-breakpoint
CREATE INDEX `project_transfer_status_source_idx` ON `project_transfer` (`status`,`source_organization_id`);--> statement-breakpoint
CREATE INDEX `project_transfer_project_status_idx` ON `project_transfer` (`project_id`,`status`);