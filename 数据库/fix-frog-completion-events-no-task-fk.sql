-- 若历史库误建了 frog_completion_events.task_id → tasks(id) 外键，项目青蛙写入会失败。
-- 本脚本删除该表上指向 tasks 的外键（可重复执行）。
-- 用法：在目标库执行本文件。

SET @db := DATABASE();

DROP PROCEDURE IF EXISTS drop_frog_completion_task_fks;
DELIMITER $$
CREATE PROCEDURE drop_frog_completion_task_fks()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE fk_name VARCHAR(255);
  DECLARE cur CURSOR FOR
    SELECT CONSTRAINT_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = @db
      AND TABLE_NAME = 'frog_completion_events'
      AND COLUMN_NAME = 'task_id'
      AND REFERENCED_TABLE_NAME = 'tasks';
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO fk_name;
    IF done = 1 THEN
      LEAVE read_loop;
    END IF;
    SET @sql := CONCAT(
      'ALTER TABLE `frog_completion_events` DROP FOREIGN KEY `',
      fk_name,
      '`'
    );
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END LOOP;
  CLOSE cur;
END$$
DELIMITER ;

CALL drop_frog_completion_task_fks();
DROP PROCEDURE IF EXISTS drop_frog_completion_task_fks;
