-- CreateTable
CREATE TABLE `usage_events` (
    `id` VARCHAR(191) NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `user_email` VARCHAR(255) NULL,
    `page_path` VARCHAR(255) NOT NULL,
    `event_type` ENUM('PAGE_VIEW', 'LLM_REQUEST') NOT NULL,
    `provider` VARCHAR(64) NULL,
    `model` VARCHAR(128) NULL,
    `success` BOOLEAN NULL,
    `status_code` INTEGER NULL,
    `duration_ms` INTEGER NULL,
    `request_bytes` INTEGER NULL,
    `response_bytes` INTEGER NULL,
    `system_length` INTEGER NULL,
    `user_length` INTEGER NULL,
    `error_message` TEXT NULL,
    `trace_id` VARCHAR(128) NULL,
    `metadata` JSON NULL,

    INDEX `idx_usage_events_occurred_at`(`occurred_at`),
    INDEX `idx_usage_events_user_occurred_at`(`user_email`, `occurred_at`),
    INDEX `idx_usage_events_type_occurred_at`(`event_type`, `occurred_at`),
    INDEX `idx_usage_events_model_occurred_at`(`provider`, `model`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
