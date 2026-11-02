CREATE TABLE `test_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`plan_id` text,
	`stage` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`document` text,
	`error` text DEFAULT '' NOT NULL,
	`requested_by` text DEFAULT 'human' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_test_scenarios_job` ON `test_scenarios` (`job_id`,`created_at`);