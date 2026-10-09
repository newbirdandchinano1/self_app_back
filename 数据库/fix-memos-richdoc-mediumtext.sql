-- RichDoc 全量富文本：memos.body TEXT -> MEDIUMTEXT（512KB JSON）
-- 正式路径：schema_migrations `015_memos_body_mediumtext`（ensure-memos-body-mediumtext.ts）
-- 本文件可作手工补跑备用。
ALTER TABLE memos MODIFY body MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;
