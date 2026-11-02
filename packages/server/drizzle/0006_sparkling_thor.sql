ALTER TABLE `plan_phases` ADD `tier` text;--> statement-breakpoint
ALTER TABLE `plan_phases` ADD `tier_requires_approval` integer DEFAULT false NOT NULL;