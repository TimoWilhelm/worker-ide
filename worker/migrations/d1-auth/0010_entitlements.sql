CREATE TABLE `entitlement` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`key` text NOT NULL,
	`value_type` text NOT NULL,
	`value` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entitlement_scope_key_idx` ON `entitlement` (`scope_id`,`key`);--> statement-breakpoint
CREATE INDEX `entitlement_scope_id_idx` ON `entitlement` (`scope_id`);