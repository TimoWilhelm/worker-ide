CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `account_provider_account_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `invitation_org_id_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE INDEX `member_org_user_idx` ON `member` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `member_user_id_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE INDEX `project_org_deleted_idx` ON `project` (`organization_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `project_deleted_created_idx` ON `project` (`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);