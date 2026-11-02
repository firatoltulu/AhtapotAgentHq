CREATE TABLE `external_sync` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_external_sync_job_key` ON `external_sync` (`job_id`,`key`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `external_url` text;