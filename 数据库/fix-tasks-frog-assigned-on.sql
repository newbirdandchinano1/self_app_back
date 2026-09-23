-- 可选：为 tasks 增加青蛙指定日列（与 self_app.sql / today-frogs 对齐）
-- 未执行时接口仍可用：服务端会回退到 extra_data.frogAssignedOn / frogAssignedDates
-- projects 表不使用该列（仅 extra_data）
-- 用法：在目标库执行本文件（可重复执行）

SET @db := DATABASE();

DROP PROCEDURE IF EXISTS add_tasks_frog_assigned_on;
DELIMITER $$
CREATE PROCEDURE add_tasks_frog_assigned_on()
BEGIN
  DECLARE col_exists INT DEFAULT 0;
  DECLARE idx_exists INT DEFAULT 0;

  SELECT COUNT(*) INTO col_exists
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'tasks'
    AND COLUMN_NAME = 'frog_assigned_on';

  IF col_exists = 0 THEN
    ALTER TABLE `tasks`
      ADD COLUMN `frog_assigned_on` date NULL DEFAULT NULL COMMENT '青蛙指定日 YYYY-MM-DD' AFTER `due_date`;
  END IF;

  SELECT COUNT(*) INTO idx_exists
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'tasks'
    AND INDEX_NAME = 'idx_tasks_frog_assigned_on';

  IF idx_exists = 0 THEN
    CREATE INDEX `idx_tasks_frog_assigned_on` ON `tasks` (`frog_assigned_on`);
  END IF;
END$$
DELIMITER ;

CALL add_tasks_frog_assigned_on();
DROP PROCEDURE IF EXISTS add_tasks_frog_assigned_on;
