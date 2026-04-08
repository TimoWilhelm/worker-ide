ALTER TABLE `project` ADD COLUMN `last_activity_at` integer;--> statement-breakpoint
UPDATE `project` SET `last_activity_at` = `updated_at` WHERE `last_activity_at` IS NULL;--> statement-breakpoint
CREATE INDEX `project_last_activity_idx` ON `project` (`last_activity_at`);
