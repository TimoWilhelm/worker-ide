CREATE TABLE `user_project_favorite` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_project_favorite_user_project_idx` ON `user_project_favorite` (`user_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `user_project_favorite_user_created_idx` ON `user_project_favorite` (`user_id`,`created_at`);--> statement-breakpoint
DROP INDEX `user_project_access_user_fav_accessed_idx`;--> statement-breakpoint
CREATE INDEX `user_project_access_user_accessed_idx` ON `user_project_access` (`user_id`,`last_accessed_at`);--> statement-breakpoint
ALTER TABLE `user_project_access` DROP COLUMN `is_favorite`;--> statement-breakpoint
ALTER TABLE `project` ADD `last_activity_at` integer;--> statement-breakpoint
UPDATE `project` SET `last_activity_at` = `updated_at` WHERE `last_activity_at` IS NULL;--> statement-breakpoint
CREATE INDEX `project_last_activity_idx` ON `project` (`last_activity_at`);
