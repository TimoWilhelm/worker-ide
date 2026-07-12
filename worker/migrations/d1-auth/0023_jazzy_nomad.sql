CREATE TABLE `cloudflare_temporary_account` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`account_id` text NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`claim_url` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cloudflare_temporary_account_expires_at_idx` ON `cloudflare_temporary_account` (`expires_at`);