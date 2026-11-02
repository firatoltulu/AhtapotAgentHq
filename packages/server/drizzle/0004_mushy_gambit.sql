CREATE TABLE `profile_image_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`image_ref` text NOT NULL,
	`log_ref` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `project_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_image_build_profile` ON `profile_image_builds` (`profile_id`,`created_at`);