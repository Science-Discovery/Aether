CREATE TABLE `session_retry` (
	`session_id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`next_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`message` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_retry_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
