ALTER TABLE `plan_phases` ADD `tier_source` text DEFAULT 'engine' NOT NULL;--> statement-breakpoint
ALTER TABLE `plan_phases` ADD `derived_tier` text;