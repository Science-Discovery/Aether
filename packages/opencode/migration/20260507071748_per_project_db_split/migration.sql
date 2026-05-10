CREATE TABLE `global_project_map` (
	`directory` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`branch` text,
	`name` text,
	`directory` text,
	`extra` text,
	`project_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_workspace`(`id`, `type`, `branch`, `name`, `directory`, `extra`, `project_id`) SELECT `id`, `type`, `branch`, `name`, `directory`, `extra`, `project_id` FROM `workspace`;--> statement-breakpoint
DROP TABLE `workspace`;--> statement-breakpoint
ALTER TABLE `__new_workspace` RENAME TO `workspace`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_recent` (
	`key` text PRIMARY KEY,
	`kind` text NOT NULL,
	`project_id` text,
	`directory` text NOT NULL,
	`name` text,
	`icon_url` text,
	`icon_color` text,
	`icon_override` text,
	`activity_at` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_project_recent`(`key`, `kind`, `project_id`, `directory`, `name`, `icon_url`, `icon_color`, `activity_at`, `time_created`, `time_updated`) SELECT `key`, `kind`, `project_id`, `directory`, `name`, `icon_url`, `icon_color`, `activity_at`, `time_created`, `time_updated` FROM `project_recent`;--> statement-breakpoint
DROP TABLE `project_recent`;--> statement-breakpoint
ALTER TABLE `__new_project_recent` RENAME TO `project_recent`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_permission` (
	`project_id` text PRIMARY KEY,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_permission`(`project_id`, `time_created`, `time_updated`, `data`) SELECT `project_id`, `time_created`, `time_updated`, `data` FROM `permission`;--> statement-breakpoint
DROP TABLE `permission`;--> statement-breakpoint
ALTER TABLE `__new_permission` RENAME TO `permission`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`workspace_id` text,
	`parent_id` text,
	`tree_id` text,
	`fork_index` integer,
	`fork_parent_session_id` text,
	`fork_after_user_message_id` text,
	`slug` text NOT NULL,
	`directory` text NOT NULL,
	`title` text NOT NULL,
	`version` text NOT NULL,
	`share_url` text,
	`summary_additions` integer,
	`summary_deletions` integer,
	`summary_files` integer,
	`summary_diffs` text,
	`revert` text,
	`permission` text,
	`reading_mode` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_compacting` integer,
	`time_archived` integer
);
--> statement-breakpoint
INSERT INTO `__new_session`(`id`, `project_id`, `workspace_id`, `parent_id`, `tree_id`, `fork_index`, `fork_parent_session_id`, `fork_after_user_message_id`, `slug`, `directory`, `title`, `version`, `share_url`, `summary_additions`, `summary_deletions`, `summary_files`, `summary_diffs`, `revert`, `permission`, `reading_mode`, `time_created`, `time_updated`, `time_compacting`, `time_archived`) SELECT `id`, `project_id`, `workspace_id`, `parent_id`, `tree_id`, `fork_index`, `fork_parent_session_id`, `fork_after_user_message_id`, `slug`, `directory`, `title`, `version`, `share_url`, `summary_additions`, `summary_deletions`, `summary_files`, `summary_diffs`, `revert`, `permission`, `reading_mode`, `time_created`, `time_updated`, `time_compacting`, `time_archived` FROM `session`;--> statement-breakpoint
DROP TABLE `session`;--> statement-breakpoint
ALTER TABLE `__new_session` RENAME TO `session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `session_project_idx` ON `session` (`project_id`);--> statement-breakpoint
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);--> statement-breakpoint
CREATE INDEX `session_tree_idx` ON `session` (`tree_id`);--> statement-breakpoint
CREATE INDEX `session_fork_parent_idx` ON `session` (`fork_parent_session_id`);--> statement-breakpoint
CREATE INDEX `session_fork_after_user_message_idx` ON `session` (`fork_after_user_message_id`);