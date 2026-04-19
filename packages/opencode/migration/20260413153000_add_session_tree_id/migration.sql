ALTER TABLE `session` ADD `tree_id` text;--> statement-breakpoint
CREATE INDEX `session_tree_idx` ON `session` (`tree_id`);
