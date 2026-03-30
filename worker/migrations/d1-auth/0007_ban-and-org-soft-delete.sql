ALTER TABLE `organization` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `banned_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `ban_reason` text;