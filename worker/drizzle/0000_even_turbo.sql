CREATE TABLE `pending_changes` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`data` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `running_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`parameters` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`title_generated` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`history` text DEFAULT '[]' NOT NULL,
	`message_snapshots` text,
	`message_modes` text,
	`context_tokens_used` integer,
	`reverted_at` integer,
	`tool_metadata` text,
	`tool_errors` text,
	`status` text,
	`error_message` text
);
