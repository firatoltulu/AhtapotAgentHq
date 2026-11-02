CREATE TABLE `triage_results` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`stage` text NOT NULL,
	`subject_id` text,
	`doc` text NOT NULL,
	`tier` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`synthesized` integer DEFAULT false NOT NULL,
	`requires_approval` integer DEFAULT false NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_triage_job_stage` ON `triage_results` (`job_id`,`stage`);--> statement-breakpoint
ALTER TABLE `projects` ADD `source_git_url` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `workspace_status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `workspace_error` text;