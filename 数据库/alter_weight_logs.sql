-- 体重日志云端表（幂等：ensure-weight-logs / migration 027 亦会创建）
-- 供健康 / 我的页趋势 / Agent snapshot

CREATE TABLE IF NOT EXISTS weight_logs (
  id VARCHAR(36) NOT NULL,
  recorded_ymd VARCHAR(10) NOT NULL COMMENT '记录日 YYYY-MM-DD',
  weight_kg DECIMAL(6,2) NOT NULL COMMENT '体重 kg',
  created_at VARCHAR(255) NOT NULL,
  updated_at VARCHAR(255) NOT NULL,
  sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
  server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本',
  mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
  PRIMARY KEY (id),
  UNIQUE KEY uk_weight_logs_ymd (recorded_ymd),
  KEY idx_weight_logs_ymd (recorded_ymd),
  KEY idx_weight_logs_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
