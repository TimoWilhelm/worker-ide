CREATE TABLE `project_transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_organization_id` text NOT NULL,
	`target_organization_id` text NOT NULL,
	`initiated_by_user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by_user_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initiated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_transfer_status_target_idx` ON `project_transfer` (`status`,`target_organization_id`);--> statement-breakpoint
CREATE INDEX `project_transfer_status_source_idx` ON `project_transfer` (`status`,`source_organization_id`);--> statement-breakpoint
CREATE INDEX `project_transfer_project_status_idx` ON `project_transfer` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `user_project_access` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`last_accessed_at` integer NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_project_access_user_project_idx` ON `user_project_access` (`user_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `user_project_access_user_fav_accessed_idx` ON `user_project_access` (`user_id`,`is_favorite`,`last_accessed_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`durable_object_hex_id` text NOT NULL,
	`name` text NOT NULL,
	`human_id` text NOT NULL,
	`preview_visibility` text DEFAULT 'public' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_project`("id", "organization_id", "durable_object_hex_id", "name", "human_id", "preview_visibility", "created_by_user_id", "created_at", "updated_at", "deleted_at") SELECT "id", "organization_id", "durable_object_hex_id", "name", "human_id", "preview_visibility", "created_by_user_id", "created_at", "updated_at", "deleted_at" FROM `project`;--> statement-breakpoint
DROP TABLE `project`;--> statement-breakpoint
ALTER TABLE `__new_project` RENAME TO `project`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `project_org_deleted_idx` ON `project` (`organization_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `project_deleted_created_idx` ON `project` (`deleted_at`,`created_at`);--> statement-breakpoint
ALTER TABLE `user` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `session` DROP COLUMN `active_organization_id`;