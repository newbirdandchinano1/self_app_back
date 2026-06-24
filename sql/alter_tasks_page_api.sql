-- 任务 Tab 页 API：完成事件表索引
-- 执行前请备份数据库；若索引已存在可跳过对应语句

CREATE INDEX `idx_tevt_created_at` ON `task_execution_events` (`created_at`);
CREATE INDEX `idx_frog_assigned_ymd` ON `frog_completion_events` (`assigned_ymd`);

-- 多用户库版本（存在 user_id 列时使用）
-- CREATE INDEX `idx_tevt_user_created` ON `task_execution_events` (`user_id`, `created_at`);
-- CREATE INDEX `idx_frog_user_assigned` ON `frog_completion_events` (`user_id`, `assigned_ymd`);
-- CREATE INDEX `idx_task_items_user` ON `task_items` (`user_id`);
-- CREATE INDEX `idx_projects_user_updated` ON `projects` (`user_id`, `updated_at`);
