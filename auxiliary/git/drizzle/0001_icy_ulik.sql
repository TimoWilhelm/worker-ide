CREATE TABLE `hydr_pending` (
	`work_id` text NOT NULL,
	`kind` text NOT NULL,
	`oid` text NOT NULL,
	PRIMARY KEY(`work_id`, `kind`, `oid`),
	CONSTRAINT "chk_hydr_pending_kind" CHECK("kind" IN ('base','loose'))
);
--> statement-breakpoint
CREATE INDEX `idx_hydr_pending_work_kind` ON `hydr_pending` (`work_id`,`kind`);