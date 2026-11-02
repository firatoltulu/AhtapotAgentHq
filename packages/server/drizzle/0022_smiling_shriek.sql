CREATE TABLE `critiques` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`subject` text NOT NULL,
	`subject_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`document` text,
	`error` text DEFAULT '' NOT NULL,
	`requested_by` text DEFAULT 'engine' NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_critiques_subject` ON `critiques` (`job_id`,`subject_id`,`created_at`);