-- projects 表增加艾森豪威尔优先级（与 tasks.priority 同口径）
-- 0未设 1不紧急不重要 2不紧急重要 3紧急不重要 4紧急重要

ALTER TABLE projects
  ADD COLUMN priority INT NOT NULL DEFAULT 0
  COMMENT '艾森豪威尔优先级：0未设 1不紧急不重要 2不紧急重要 3紧急不重要 4紧急重要'
  AFTER status;

-- 兜底：若列曾允许 NULL，统一历史数据
UPDATE projects SET priority = 0 WHERE priority IS NULL;
