-- 任务日历 API（无 user_id 列的单用户库版本）
-- 若 alter_calendar_api.sql 因缺少 user_id 失败，使用本脚本

ALTER TABLE `tasks`
  ADD COLUMN `frog_assigned_on` DATE NULL COMMENT '青蛙指定日 YYYY-MM-DD' AFTER `due_date`;

CREATE INDEX `idx_hci_record_date` ON `habit_check_ins` (`record_date`);
CREATE INDEX `idx_tasks_due_date` ON `tasks` (`due_date`);
CREATE INDEX `idx_tasks_frog_assigned_on` ON `tasks` (`frog_assigned_on`);
CREATE INDEX `idx_tasks_updated_at` ON `tasks` (`updated_at`);
CREATE INDEX `idx_projects_due_date` ON `projects` (`due_date`);
CREATE INDEX `idx_habits_updated_at` ON `habits` (`updated_at`);

UPDATE `tasks`
SET `frog_assigned_on` = JSON_UNQUOTE(JSON_EXTRACT(`extra_data`, '$.frogAssignedOn'))
WHERE `frog_assigned_on` IS NULL
  AND JSON_EXTRACT(`extra_data`, '$.frogAssignedOn') IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(`extra_data`, '$.frogAssignedOn')) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
