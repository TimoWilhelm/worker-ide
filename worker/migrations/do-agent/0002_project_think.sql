DROP TABLE IF EXISTS `running_sessions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `sessions`;
--> statement-breakpoint
CREATE TABLE `session_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`title_generated` integer DEFAULT 0 NOT NULL,
	`context_tokens_used` integer,
	`tool_metadata` text,
	`tool_errors` text,
	`status` text,
	`error_message` text,
	`stop_requested` integer DEFAULT 0 NOT NULL
);
