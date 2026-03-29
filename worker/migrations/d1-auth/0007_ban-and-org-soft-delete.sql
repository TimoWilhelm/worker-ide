-- Add ban support to user table
ALTER TABLE user ADD COLUMN banned_at INTEGER;
--> statement-breakpoint
ALTER TABLE user ADD COLUMN ban_reason TEXT;
--> statement-breakpoint
-- Add soft-delete support to organization table
ALTER TABLE organization ADD COLUMN deleted_at INTEGER;
