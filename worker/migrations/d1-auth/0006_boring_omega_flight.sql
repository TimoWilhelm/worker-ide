CREATE TABLE `billing_event` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_event_org_id_idx` ON `billing_event` (`organization_id`);--> statement-breakpoint
CREATE INDEX `billing_event_type_idx` ON `billing_event` (`type`);--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`amount` integer NOT NULL,
	`balance` integer NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`reference_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credit_ledger_org_id_idx` ON `credit_ledger` (`organization_id`);--> statement-breakpoint
CREATE INDEX `credit_ledger_type_idx` ON `credit_ledger` (`type`);--> statement-breakpoint
CREATE INDEX `credit_ledger_reference_idx` ON `credit_ledger` (`reference_id`);--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_period_start` integer,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`external_id` text,
	`external_customer_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subscription_org_id_idx` ON `subscription` (`organization_id`);--> statement-breakpoint
CREATE INDEX `subscription_external_id_idx` ON `subscription` (`external_id`);