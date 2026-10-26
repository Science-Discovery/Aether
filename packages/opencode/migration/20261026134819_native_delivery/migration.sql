CREATE TABLE IF NOT EXISTS `native_dispatch` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`assistant_id` text NOT NULL,
	`assistant` text,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`reviews` text DEFAULT '[]' NOT NULL,
	`state` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_native_dispatch_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_input` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`data` text NOT NULL,
	`context` integer NOT NULL,
	`state` text NOT NULL,
	`dispatch_id` text,
	`time_created` integer NOT NULL,
	CONSTRAINT `fk_native_input_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_state` (
	`session_id` text PRIMARY KEY,
	`version` integer NOT NULL,
	`home` text,
	`time_synced` integer,
	CONSTRAINT `fk_native_state_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `native_dispatch_session_idx` ON `native_dispatch` (`session_id`,`time_created`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `native_input_session_idx` ON `native_input` (`session_id`,`time_created`,`id`);
