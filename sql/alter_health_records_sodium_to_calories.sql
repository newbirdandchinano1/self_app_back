-- health_records：钠 → 摄入热量（kcal）
ALTER TABLE `health_records`
  CHANGE COLUMN `sodium` `calories` double NOT NULL DEFAULT 0,
  CHANGE COLUMN `target_sodium` `target_calories` double NOT NULL DEFAULT 0;
