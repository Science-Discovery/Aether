CREATE TABLE `cron_job_state` (
	`job_id` text PRIMARY KEY,
	`enabled` integer NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text,
	`running` integer NOT NULL DEFAULT false,
	`start_at` integer,
	`definition_snapshot` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cron_job_state_next_run_idx` ON `cron_job_state` (`next_run_at`);
--> statement-breakpoint
CREATE TABLE `cron_run` (
	`run_id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`status` text NOT NULL,
	`output_summary` text,
	`mode` text NOT NULL,
	`project_id` text,
	`session_id` text,
	`created_session_id` text,
	`payload_snapshot` text NOT NULL,
	`trigger_reason` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cron_run_job_started_idx` ON `cron_run` (`job_id`, `started_at`);
