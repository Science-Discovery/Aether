CREATE TABLE `project_recent` (
	`key` text PRIMARY KEY,
	`kind` text NOT NULL,
	`project_id` text,
	`directory` text NOT NULL,
	`activity_at` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `project_recent_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `project_recent_activity_idx` ON `project_recent` (`activity_at`);
--> statement-breakpoint
INSERT INTO `project_recent` (`key`, `kind`, `project_id`, `directory`, `activity_at`, `time_created`, `time_updated`)
SELECT
	'project:' || `id`,
	'project',
	`id`,
	`worktree`,
	MAX(COALESCE(`time_updated`, 0), COALESCE(`time_created`, 0)),
	COALESCE(`time_created`, strftime('%s','now') * 1000),
	COALESCE(`time_updated`, COALESCE(`time_created`, strftime('%s','now') * 1000))
FROM `project`
WHERE `worktree` IS NOT NULL
	AND `worktree` != '/'
	AND `id` != 'global';
--> statement-breakpoint
INSERT INTO `project_recent` (`key`, `kind`, `project_id`, `directory`, `activity_at`, `time_created`, `time_updated`)
SELECT
	'dir:' || lower(rtrim(replace(`directory`, '\\', '/'), '/')),
	'directory',
	NULL,
	`directory`,
	MAX(`time_updated`),
	MAX(`time_updated`),
	MAX(`time_updated`)
FROM `session`
WHERE `directory` IS NOT NULL
	AND `directory` != '/'
	AND `directory` NOT LIKE '%/bin'
	AND `directory` NOT LIKE '%/dist'
	AND `directory` NOT LIKE '%\\bin'
	AND `directory` NOT LIKE '%\\dist'
GROUP BY `directory`;
