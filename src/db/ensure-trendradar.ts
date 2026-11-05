import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';
import { computeNewsUrlHash } from '../utils/trendradar-dedupe.js';
import { normalizeTrendRadarUrl } from '../utils/trendradar-url.js';
import { ensureColumn, indexExists, tableExists } from './schema-helpers.js';

/**
 * 幂等：TrendRadar 热点入库表。
 *
 * 来源有两条：
 * 1) sqlite-sync：服务器同步脚本读 TrendRadar 的 output/news/YYYY-MM-DD.db 后调 /api/news/import
 * 2) webhook：TrendRadar 通用 Webhook 推送 Markdown，本服务解析入库
 *
 * - trendradar_report        一份报告（webhook 按 类型+生成时间；sqlite-sync 按日期）
 * - trendradar_report_batch  每个 webhook 批次原文（分批推送可重放/排查）
 * - trendradar_news          新闻条目（平台 / 排名 / 时间窗口 / 关键词组）
 */
export async function ensureTrendRadarTables(): Promise<void> {
  if (!(await tableExists('trendradar_report'))) {
    await db.query(`
      CREATE TABLE trendradar_report (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        source_kind VARCHAR(16) NOT NULL DEFAULT 'webhook' COMMENT 'webhook|sqlite-sync',
        mode VARCHAR(16) NULL COMMENT 'current|daily|incremental',
        mode_label VARCHAR(32) NULL COMMENT 'TrendRadar 原始类型：当前榜单/当日汇总/增量监控/db-sync',
        report_time DATETIME NULL COMMENT '报告时间（UTC）',
        report_date DATE NULL COMMENT '报告本地日期（Asia/Shanghai）',
        batch_total INT NOT NULL DEFAULT 0,
        batch_received INT NOT NULL DEFAULT 0,
        item_count INT NOT NULL DEFAULT 0,
        total_news INT NULL COMMENT '总新闻条数',
        new_news INT NULL COMMENT '本轮新增条数',
        hotlist_matched INT NULL COMMENT '热榜命中条数',
        hotlist_total INT NULL COMMENT '热榜抓取总条数',
        platform_ok INT NULL COMMENT '抓取成功平台数',
        platform_total INT NULL COMMENT '平台总数',
        rss_matched INT NULL COMMENT 'RSS 命中条数',
        rss_total INT NULL COMMENT 'RSS 条目总数',
        rss_source_ok INT NULL COMMENT 'RSS 成功源数',
        rss_source_total INT NULL COMMENT 'RSS 源总数',
        top_topics VARCHAR(512) NULL COMMENT '最热话题摘要',
        first_received_at DATETIME NOT NULL,
        last_received_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_trendradar_report (mode_label, report_time),
        KEY ix_trendradar_report_date (report_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 trendradar_report');
  }

  if (!(await tableExists('trendradar_report_batch'))) {
    await db.query(`
      CREATE TABLE trendradar_report_batch (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        report_id BIGINT UNSIGNED NOT NULL,
        batch_index INT NOT NULL DEFAULT 1,
        batch_total INT NOT NULL DEFAULT 1,
        content_sha1 CHAR(40) NOT NULL,
        title VARCHAR(64) NULL,
        content MEDIUMTEXT NOT NULL COMMENT 'webhook content 原文',
        received_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_trendradar_batch (report_id, batch_index),
        KEY ix_trendradar_batch_sha1 (content_sha1)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 trendradar_report_batch');
  }

  if (!(await tableExists('trendradar_news'))) {
    await db.query(`
      CREATE TABLE trendradar_news (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        report_id BIGINT UNSIGNED NOT NULL,
        report_date DATE NOT NULL,
        section VARCHAR(16) NOT NULL DEFAULT 'hotlist' COMMENT 'hotlist|rss',
        keyword_group VARCHAR(255) NOT NULL DEFAULT '' COMMENT '命中词组',
        group_seq INT NULL COMMENT '词组序号',
        group_total INT NULL COMMENT '词组总数',
        group_count INT NULL COMMENT '该词组命中条数',
        seq_no INT NULL COMMENT '组内序号',
        platform_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '平台唯一标识（如 baidu）',
        platform_name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '来源平台名称',
        title VARCHAR(512) NOT NULL,
        url VARCHAR(1024) NULL,
        url_hash CHAR(40) NULL COMMENT 'sha1(normalize_url(url))，日级去重；空 URL 为 NULL',
        rank_no INT NULL COMMENT '排名（区间取起始值）',
        rank_end INT NULL COMMENT '排名区间结束值',
        rank_trend VARCHAR(8) NULL COMMENT 'up|down',
        appear_time VARCHAR(64) NULL COMMENT '出现时间/时间窗口原文',
        first_crawl_time VARCHAR(32) NULL COMMENT '首次抓取时间（TrendRadar 本地时间）',
        last_crawl_time VARCHAR(32) NULL COMMENT '最后抓取时间（TrendRadar 本地时间）',
        crawl_count INT NULL COMMENT '出现次数',
        is_new TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否首次入库',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        -- 对齐官方：同日同平台同规范化 URL 只留一条（不含 title/report_id，避免 webhook 多报告堆重复）
        UNIQUE KEY uk_trendradar_news_day (report_date, section, platform_name, url_hash),
        KEY ix_trendradar_news_date (report_date),
        KEY ix_trendradar_news_group (keyword_group),
        KEY ix_trendradar_news_platform (platform_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 trendradar_news');
  }

  if (!(await indexExists('trendradar_report', 'ix_trendradar_report_date'))) {
    await db.query(
      `CREATE INDEX ix_trendradar_report_date ON trendradar_report (report_date)`,
    );
    console.log('[DB] 已创建索引 ix_trendradar_report_date');
  }
  if (!(await indexExists('trendradar_news', 'ix_trendradar_news_date'))) {
    await db.query(
      `CREATE INDEX ix_trendradar_news_date ON trendradar_news (report_date)`,
    );
    console.log('[DB] 已创建索引 ix_trendradar_news_date');
  }

  await ensureTrendRadarSyncColumns();
}

/** 老库补列：sqlite 同步需要的平台 ID 与抓取时间；并切换日级去重唯一键 */
export async function ensureTrendRadarSyncColumns(): Promise<void> {
  await ensureColumn(
    'trendradar_report',
    'source_kind',
    "VARCHAR(16) NOT NULL DEFAULT 'webhook' COMMENT 'webhook|sqlite-sync'",
  );
  await ensureColumn(
    'trendradar_news',
    'platform_id',
    "VARCHAR(64) NOT NULL DEFAULT '' COMMENT '平台唯一标识（如 baidu）'",
  );
  await ensureColumn('trendradar_news', 'first_crawl_time', 'VARCHAR(32) NULL');
  await ensureColumn('trendradar_news', 'last_crawl_time', 'VARCHAR(32) NULL');
  if (!(await indexExists('trendradar_news', 'ix_trendradar_news_platform_id'))) {
    await db.query(
      `CREATE INDEX ix_trendradar_news_platform_id ON trendradar_news (platform_id)`,
    );
    console.log('[DB] 已创建索引 ix_trendradar_news_platform_id');
  }

  await ensureTrendRadarDayDedupeIndex();
}

/**
 * 将唯一键从 (report_id, …, title) 迁到日级 (report_date, section, platform_name, url_hash)。
 * 迁移时：重算规范化 url_hash → 折叠同日重复 → 换唯一键。
 */
async function ensureTrendRadarDayDedupeIndex(): Promise<void> {
  const hasNew = await indexExists('trendradar_news', 'uk_trendradar_news_day');
  const hasOld = await indexExists('trendradar_news', 'uk_trendradar_news');
  if (hasNew && !hasOld) return;

  // 1) 按官方规则重算 url_hash（去掉微博 band_rank 等动态参数）
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, url, platform_id, url_hash FROM trendradar_news
      WHERE url IS NOT NULL AND url <> ''`,
  );
  let rehashed = 0;
  for (const row of rows as Array<{
    id: number;
    url: string;
    platform_id: string;
    url_hash: string | null;
  }>) {
    const normalized = normalizeTrendRadarUrl(row.url, row.platform_id || '');
    const nextHash = computeNewsUrlHash(normalized || row.url, row.platform_id || '');
    const nextUrl = normalized || row.url;
    if (nextHash === row.url_hash && nextUrl === row.url) continue;
    await db.query(
      `UPDATE trendradar_news SET url = ?, url_hash = ? WHERE id = ?`,
      [nextUrl, nextHash, row.id],
    );
    rehashed += 1;
  }
  if (rehashed > 0) {
    console.log(`[DB] 已按官方规则重算 url_hash ${rehashed} 条`);
  }

  // 2) 折叠：同日同 section/platform/url_hash 多行 → 留一条
  //    优先 platform_id 非空（sqlite-sync），再取最大 id
  const [delResult] = await db.query(
    `
    DELETE n FROM trendradar_news n
    INNER JOIN (
      SELECT report_date, section, platform_name, url_hash,
             SUBSTRING_INDEX(
               GROUP_CONCAT(id ORDER BY (platform_id <> '') DESC, id DESC),
               ',', 1
             ) AS keep_id
        FROM trendradar_news
       WHERE url_hash IS NOT NULL AND url_hash <> ''
       GROUP BY report_date, section, platform_name, url_hash
      HAVING COUNT(*) > 1
    ) d
      ON n.report_date = d.report_date
     AND n.section = d.section
     AND n.platform_name = d.platform_name
     AND n.url_hash = d.url_hash
     AND n.id <> CAST(d.keep_id AS UNSIGNED)
  `,
  );
  const deleted = Number(
    (delResult as { affectedRows?: number } | undefined)?.affectedRows ?? 0,
  );
  if (deleted > 0) {
    console.log(`[DB] 已折叠日级重复新闻 ${deleted} 条`);
  }

  // 3) 换唯一键
  if (!hasNew) {
    await db.query(`
      ALTER TABLE trendradar_news
        ADD UNIQUE KEY uk_trendradar_news_day (report_date, section, platform_name, url_hash)
    `);
    console.log('[DB] 已创建唯一键 uk_trendradar_news_day');
  }
  if (hasOld) {
    await db.query(`ALTER TABLE trendradar_news DROP INDEX uk_trendradar_news`);
    console.log('[DB] 已删除旧唯一键 uk_trendradar_news');
  }
}