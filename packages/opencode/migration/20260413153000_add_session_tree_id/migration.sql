ALTER TABLE `session` ADD `tree_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `fork_parent_session_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `fork_after_user_message_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `fork_index` integer;--> statement-breakpoint
CREATE INDEX `session_tree_idx` ON `session` (`tree_id`);--> statement-breakpoint
CREATE INDEX `session_fork_parent_idx` ON `session` (`fork_parent_session_id`);--> statement-breakpoint
CREATE INDEX `session_fork_after_user_message_idx` ON `session` (`fork_after_user_message_id`);
