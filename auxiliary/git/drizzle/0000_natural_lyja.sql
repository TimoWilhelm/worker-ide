CREATE TABLE `hydr_cover` (
	`work_id` text NOT NULL,
	`oid` text NOT NULL,
	PRIMARY KEY(`work_id`, `oid`)
);
--> statement-breakpoint
CREATE INDEX `idx_hydr_cover_oid` ON `hydr_cover` (`oid`);--> statement-breakpoint
CREATE TABLE `pack_objects` (
	`pack_key` text NOT NULL,
	`oid` text NOT NULL,
	PRIMARY KEY(`pack_key`, `oid`)
);
--> statement-breakpoint
CREATE INDEX `idx_pack_objects_oid` ON `pack_objects` (`oid`);