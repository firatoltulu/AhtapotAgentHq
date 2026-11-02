CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`job_id` text,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`status` text DEFAULT 'running' NOT NULL,
	`identity_index` integer,
	`started_at` text NOT NULL,
	`ended_at` text,
	`num_turns` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`stop_reason` text,
	`error_message` text,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_runs_job` ON `agent_runs` (`job_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `ix_runs_session` ON `agent_runs` (`session_id`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`role` text NOT NULL,
	`sdk_session_id` text,
	`model` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`transcript_ref` text,
	`total_cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`closed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_sessions_job_role` ON `agent_sessions` (`job_id`,`role`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`project_id` text,
	`kind` text NOT NULL,
	`subject_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text,
	`edits` text,
	`comment` text DEFAULT '' NOT NULL,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_approvals_job_status` ON `approvals` (`job_id`,`status`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`run_id` text,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_artifacts_job_type` ON `artifacts` (`job_id`,`type`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`action` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_audit_created` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `builds` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`phase_id` text,
	`step_name` text NOT NULL,
	`command` text NOT NULL,
	`skipped` integer DEFAULT false NOT NULL,
	`skip_reason` text DEFAULT '' NOT NULL,
	`exit_code` integer,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`log_ref` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`phase_id`) REFERENCES `plan_phases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_builds_job` ON `builds` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cost_records` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`run_id` text,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`micro_usd` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_cost_job` ON `cost_records` (`job_id`);--> statement-breakpoint
CREATE INDEX `ix_cost_created` ON `cost_records` (`created_at`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`index_no` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'api_key' NOT NULL,
	`cooldown_until` text,
	`last_used_at` text,
	`total_micro_usd` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_index_no_unique` ON `identities` (`index_no`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_events_job_seq` ON `job_events` (`job_id`,`seq`);--> statement-breakpoint
CREATE TABLE `job_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`actor` text,
	`payload` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_transitions_job` ON `job_transitions` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`profile_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`external_ref` text,
	`source` text DEFAULT 'ui' NOT NULL,
	`state` text DEFAULT 'Draft' NOT NULL,
	`phase` text DEFAULT 'done' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`loop_counts` text NOT NULL,
	`target_repos` text NOT NULL,
	`branch_name` text,
	`worktree_path` text,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `project_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_jobs_project_state` ON `jobs` (`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_jobs_state_updated` ON `jobs` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_jobs_external` ON `jobs` (`source`,`external_ref`);--> statement-breakpoint
CREATE TABLE `live_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`compose_project` text NOT NULL,
	`network_name` text NOT NULL,
	`app_url` text,
	`ports` text NOT NULL,
	`db_volume` text,
	`status` text DEFAULT 'starting' NOT NULL,
	`started_at` text NOT NULL,
	`expires_at` text,
	`stopped_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_live_job` ON `live_environments` (`job_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`run_id` text,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_messages_job_seq` ON `messages` (`job_id`,`seq`);--> statement-breakpoint
CREATE TABLE `plan_phases` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`job_id` text NOT NULL,
	`order` integer NOT NULL,
	`title` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`files` text NOT NULL,
	`risk` text DEFAULT 'low' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`exceeds_file_cap` integer DEFAULT false NOT NULL,
	`approved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_phase_plan_order` ON `plan_phases` (`plan_id`,`order`);--> statement-breakpoint
CREATE INDEX `ix_phase_job_status` ON `plan_phases` (`job_id`,`status`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`document` text NOT NULL,
	`agent_run_id` text,
	`approved_at` text,
	`approved_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_plan_job_version` ON `plans` (`job_id`,`version`);--> statement-breakpoint
CREATE TABLE `project_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`document` text NOT NULL,
	`rationale` text,
	`analysis_id` text,
	`approved_at` text,
	`approved_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_profile_project_version` ON `project_profiles` (`project_id`,`version`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`workspace_root` text NOT NULL,
	`active_profile_id` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`ci_status` text,
	`review_status` text,
	`merged_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_prs_job` ON `pull_requests` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_pr_provider_repo_number` ON `pull_requests` (`provider`,`repo`,`number`);--> statement-breakpoint
CREATE TABLE `qa_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`title` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'agent' NOT NULL,
	`included` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_qa_cases_job` ON `qa_cases` (`job_id`);--> statement-breakpoint
CREATE TABLE `resource_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`state` text DEFAULT 'held' NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text,
	`released_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_lease_kind_value_held` ON `resource_leases` (`kind`,`value`) WHERE state = 'held';--> statement-breakpoint
CREATE INDEX `ix_leases_job` ON `resource_leases` (`job_id`);--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`kind` text DEFAULT 'run' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`preexisting_failures` text NOT NULL,
	`report_ref` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_tests_job` ON `test_runs` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`fingerprint` text,
	`findings` text,
	`error` text,
	`agent_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_analysis_project` ON `workspace_analyses` (`project_id`,`created_at`);