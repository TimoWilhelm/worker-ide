CREATE TABLE `session_message_metadata` (
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`request_mode` text,
	`request_model` text,
	`request_state` text,
	`snapshot_id` text,
	PRIMARY KEY(`session_id`, `message_id`)
);
