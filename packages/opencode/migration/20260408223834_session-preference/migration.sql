CREATE TABLE `session_preference` (
	`session_id` text PRIMARY KEY,
	`agent` text,
	`model_provider_id` text,
	`model_id` text,
	`variant` text,
	`auto_accept` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_preference_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
