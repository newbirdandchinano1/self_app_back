-- 待办总览页 API：overview scope 与执行事件查询索引
-- 执行前请备份数据库；若索引已存在可跳过对应语句

CREATE INDEX `idx_tee_task_id_created` ON `task_execution_events` (`task_id`, `created_at`);
CREATE INDEX `idx_tasks_overview_scope` ON `tasks` (`project_id`, `parent_task_id`, `status`, `updated_at`);
