PRAGMA defer_foreign_keys=ON;--> statement-breakpoint

CREATE TABLE `_org_id_map` (
	`old_id` text PRIMARY KEY NOT NULL,
	`new_id` text NOT NULL UNIQUE,
	`new_slug` text NOT NULL UNIQUE
);--> statement-breakpoint

INSERT INTO `_org_id_map` (`old_id`, `new_id`, `new_slug`)
SELECT
	`id`,
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
FROM `organization`;--> statement-breakpoint

UPDATE `member`
SET `organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `member`.`organization_id`)
WHERE `organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `invitation`
SET `organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `invitation`.`organization_id`)
WHERE `organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `project`
SET `organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `project`.`organization_id`)
WHERE `organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `project`
SET `deleted_via_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `project`.`deleted_via_id`)
WHERE `deleted_via_type` = 'organization' AND `deleted_via_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `project_transfer`
SET `source_organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `project_transfer`.`source_organization_id`)
WHERE `source_organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `project_transfer`
SET `target_organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `project_transfer`.`target_organization_id`)
WHERE `target_organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `subscription`
SET `organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `subscription`.`organization_id`)
WHERE `organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `billing_event`
SET `organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `billing_event`.`organization_id`)
WHERE `organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `credit_ledger`
SET `organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `credit_ledger`.`organization_id`)
WHERE `organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `session`
SET `active_organization_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `session`.`active_organization_id`)
WHERE `active_organization_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `entitlement`
SET `scope_id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `entitlement`.`scope_id`)
WHERE `key` LIKE 'org:%' AND `scope_id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

UPDATE `organization`
SET
	`id` = (SELECT `new_id` FROM `_org_id_map` WHERE `old_id` = `organization`.`id`),
	`slug` = (SELECT `new_slug` FROM `_org_id_map` WHERE `old_id` = `organization`.`id`)
WHERE `id` IN (SELECT `old_id` FROM `_org_id_map`);--> statement-breakpoint

DROP TABLE `_org_id_map`;--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
