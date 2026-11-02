CREATE TABLE `project_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`profile_id` text,
	`trigger` text NOT NULL,
	`scheduled_for` text,
	`status` text DEFAULT 'starting' NOT NULL,
	`bump` text,
	`repo` text,
	`from_version` text,
	`to_version` text,
	`workflow_file` text,
	`ref` text,
	`skip_reason` text,
	`run_id` text,
	`run_url` text,
	`tag` text,
	`error` text,
	`requested_by` text NOT NULL,
	`dispatched_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_release_project` ON `project_releases` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_release_project_slot` ON `project_releases` (`project_id`,`scheduled_for`);--> statement-breakpoint
ALTER TABLE `projects` ADD `release_paused_until` text;