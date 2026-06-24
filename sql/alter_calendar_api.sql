-- 任务日历 API：索引 + tasks.frog_assigned_on 列化
-- 执行前请备份数据库

-- T5: 青蛙指定日列化
ALTER TABLE `tasks`
  ADD COLUMN `frog_assigned_on` DATE NULL COMMENT '青蛙指定日 YYYY-MM-DD' AFTER `due_date`;

-- T6: 日历相关索引
CREATE INDEX `idx_hci_user_date` ON `habit_check_ins` (`user_id`, `record_date`);
CREATE INDEX `idx_tasks_user_due` ON `tasks` (`user_id`, `due_date`);
CREATE INDEX `idx_tasks_user_frog` ON `tasks` (`user_id`, `frog_assigned_on`);
CREATE INDEX `idx_tasks_user_updated` ON `tasks` (`user_id`, `updated_at`);
CREATE INDEX `idx_projects_user_due` ON `projects` (`user_id`, `due_date`);
CREATE INDEX `idx_habits_user_updated` ON `habits` (`user_id`, `updated_at`);

-- T5: 从 extra_data 回填 frog_assigned_on（仅合法 YYYY-MM-DD）
UPDATE `tasks`
SET `frog_assigned_on` = JSON_UNQUOTE(JSON_EXTRACT(`extra_data`, '$.frogAssignedOn'))
WHERE `frog_assigned_on` IS NULL
  AND JSON_EXTRACT(`extra_data`, '$.frogAssignedOn') IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(`extra_data`, '$.frogAssignedOn')) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
