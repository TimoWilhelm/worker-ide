ALTER TABLE `session_metadata` ADD `history_json` text;
--> statement-breakpoint
ALTER TABLE `session_metadata` ADD `stop_requested` integer DEFAULT 0 NOT NULL;
