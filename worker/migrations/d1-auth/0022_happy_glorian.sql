CREATE TABLE `cloudflare_connection` (
	`user_id` text PRIMARY KEY NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`refresh_token_encrypted` text,
	`access_token_expires_at` integer,
	`scope` text,
	`cloudflare_email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cloudflare_connection_user_id_idx` ON `cloudflare_connection` (`user_id`);