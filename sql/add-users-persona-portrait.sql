-- users 表增加人物画像/自我介绍（客户端限制最多 500 字）

ALTER TABLE users
  ADD COLUMN persona_portrait TEXT NULL
  COMMENT '人物画像/自我介绍，客户端限制最多 500 字'
  AFTER avatar_uri;
