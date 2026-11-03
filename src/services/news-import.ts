import { createHash } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { nowUtcMysql } from './points-wallet.js';
import {
  listTrendRadarNews,
  shanghaiDate,
  type TrendRadarNewsDto,
} from './trendradar.js';

/**
 * 结构化新闻导入：服务器同步脚本读 TrendRadar 的 output/news/YYYY-MM-DD.db，
 * 组装 JSON 后 POST /api/news/import。这里做校验、去重、落库与查询。
 *
 * 同一天重复同步 = 更新同一份 db-sync 报告，不会产生重复数据。
 */

export class NewsImportError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'NewsImportError';
  }
}

const DB_SYNC_MODE_LABEL = 'db-sync';
const MAX_ITEMS = 5000;

export type NewsImportItem = {
  title: string;
  platformId: string;
  platformName: string;
  rank: number | null;
  url: string | null;
  crawlCount: number | null;
  firstCrawlTime: string | null;
  lastCrawlTime: string | null;
};

export type NewsImportResult = {
  reportId: number;
  reportDate: string;
  itemsReceived: number;
  itemsStored: number;
  newItems: number;
  platforms: number;
};

function asString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asInt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function normalizeItems(raw: unknown): NewsImportItem[] {
  if (!Array.isArray(raw)) throw new NewsImportError('items 必须是数组', 400);
  if (raw.length > MAX_ITEMS) {
    throw new NewsImportError(`items 数量超过上限 ${MAX_ITEMS}`, 400);
  }

  const out: NewsImportItem[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const title = asString(row.title, 512);
    if (!title) continue;

    const platformId = asString(row.platformId, 64);
    const platformName = asString(row.platformName, 64) || platformId;
    if (!platformName) continue;

    const url = asString(row.url, 1024) || asString(row.mobileUrl, 1024) || null;
    const dedupeKey = `${platformName}\u0000${sha1(url ?? '')}\u0000${title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      title,
      platformId,
      platformName,
      rank: asInt(row.rank),
      url,
      crawlCount: asInt(row.crawlCount),
      firstCrawlTime: asString(row.firstCrawlTime, 32) || null,
      lastCrawlTime: asString(row.lastCrawlTime, 32) || null,
    });
  }

  return out;
}

/** 判断这些条目的 URL 是否在更早日期出现过（用于 is_new） */
async function loadSeenHashes(
  reportDate: string,
  hashes: string[],
): Promise<Set<string>> {
  const seen = new Set<string>();
  const unique = [...new Set(hashes.filter(Boolean))];
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT DISTINCT url_hash FROM trendradar_news
        WHERE report_date < ? AND url_hash IN (${chunk.map(() => '?').join(',')})`,
      [reportDate, ...chunk],
    );
    for (const row of rows) {
      const h = (row as { url_hash?: string }).url_hash;
      if (h) seen.add(String(h));
    }
  }
  return seen;
}

export async function importNewsSnapshot(payload: {
  reportDate?: unknown;
  items?: unknown;
}): Promise<NewsImportResult> {
  const reportDate = asString(payload.reportDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new NewsImportError('reportDate 必须是 YYYY-MM-DD', 400);
  }

  const items = normalizeItems(payload.items);
  if (items.length === 0) {
    throw new NewsImportError('items 为空', 400);
  }

  const now = nowUtcMysql();
  const reportTime = `${reportDate} 00:00:00`;
  const platformTotal = new Set(items.map((i) => i.platformName)).size;

  const [reportResult] = await db.query<ResultSetHeader>(
    `INSERT INTO trendradar_report
       (source_kind, mode, mode_label, report_time, report_date, batch_total, batch_received,
        item_count, total_news, new_news, platform_total, first_received_at, last_received_at)
     VALUES ('sqlite-sync', 'daily', ?, ?, ?, 0, 0, 0, ?, 0, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       total_news = VALUES(total_news),
       platform_total = VALUES(platform_total),
       last_received_at = VALUES(last_received_at)`,
    [DB_SYNC_MODE_LABEL, reportTime, reportDate, items.length, platformTotal, now, now],
  );
  const reportId = reportResult.insertId;
  if (!reportId) throw new NewsImportError('报告写入失败', 500);

  const hashes = items.map((i) => sha1(i.url ?? ''));
  const seen = await loadSeenHashes(reportDate, hashes);

  const rows = items.map((item, idx) => [
    reportId,
    reportDate,
    'hotlist',
    '',
    item.platformId,
    item.platformName,
    item.title,
    item.url,
    hashes[idx],
    item.rank,
    item.lastCrawlTime,
    item.firstCrawlTime,
    item.lastCrawlTime,
    item.crawlCount,
    seen.has(hashes[idx]!) ? 0 : 1,
  ]);

  const CHUNK = 200;
  let newItems = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.query<ResultSetHeader>(
      `INSERT INTO trendradar_news
         (report_id, report_date, section, keyword_group, platform_id, platform_name,
          title, url, url_hash, rank_no, appear_time, first_crawl_time, last_crawl_time,
          crawl_count, is_new)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         platform_id = VALUES(platform_id),
         rank_no = VALUES(rank_no),
         appear_time = VALUES(appear_time),
         first_crawl_time = VALUES(first_crawl_time),
         last_crawl_time = VALUES(last_crawl_time),
         crawl_count = VALUES(crawl_count)`,
      [chunk],
    );
    newItems += chunk.filter((row) => row[14] === 1).length;
  }

  const [aggRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(is_new), 0) AS newCount
       FROM trendradar_news WHERE report_id = ?`,
    [reportId],
  );
  const agg = aggRows[0] as { total?: number; newCount?: number } | undefined;
  const stored = Number(agg?.total ?? 0);
  const storedNew = Number(agg?.newCount ?? 0);

  await db.query(
    `UPDATE trendradar_report SET item_count = ?, new_news = ? WHERE id = ?`,
    [stored, storedNew, reportId],
  );

  return {
    reportId,
    reportDate,
    itemsReceived: items.length,
    itemsStored: stored,
    newItems: storedNew,
    platforms: platformTotal,
  };
}

export type NewsDateDto = { date: string; itemCount: number; newCount: number };

export type TrendRadarPurgeResult = {
  keepDate: string;
  deletedNews: number;
  deletedBatches: number;
  deletedReports: number;
};

/**
 * 删除 keepDate（不含）之前的热点数据，默认只保留「上海时区今天」。
 * 顺序：news → batch → report，表间无外键约束。
 */
export async function purgeTrendRadarOlderThan(
  keepDateInput?: string | null,
): Promise<TrendRadarPurgeResult> {
  const keepDate = (keepDateInput && String(keepDateInput).trim()) || shanghaiDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(keepDate)) {
    throw new NewsImportError('keepDate 必须是 YYYY-MM-DD', 400);
  }

  const [newsResult] = await db.query<ResultSetHeader>(
    `DELETE FROM trendradar_news WHERE report_date < ?`,
    [keepDate],
  );
  const [batchResult] = await db.query<ResultSetHeader>(
    `DELETE b FROM trendradar_report_batch b
       INNER JOIN trendradar_report r ON r.id = b.report_id
      WHERE r.report_date < ?
         OR (r.report_date IS NULL AND DATE(r.report_time) < ?)`,
    [keepDate, keepDate],
  );
  const [reportResult] = await db.query<ResultSetHeader>(
    `DELETE FROM trendradar_report
      WHERE report_date < ?
         OR (report_date IS NULL AND DATE(report_time) < ?)`,
    [keepDate, keepDate],
  );

  return {
    keepDate,
    deletedNews: Number(newsResult.affectedRows ?? 0),
    deletedBatches: Number(batchResult.affectedRows ?? 0),
    deletedReports: Number(reportResult.affectedRows ?? 0),
  };
}

export async function listNewsDates(limit = 60): Promise<NewsDateDto[]> {
  const max = Math.min(200, Math.max(1, Math.floor(limit)));
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT report_date AS date, COUNT(*) AS itemCount, COALESCE(SUM(is_new), 0) AS newCount
       FROM trendradar_news
      GROUP BY report_date
      ORDER BY report_date DESC
      LIMIT ?`,
    [max],
  );
  return (rows as Array<{ date: string; itemCount: number; newCount: number }>).map((r) => ({
    date: String(r.date),
    itemCount: Number(r.itemCount ?? 0),
    newCount: Number(r.newCount ?? 0),
  }));
}

export async function listLatestNews(params: {
  platform?: string | null;
  keyword?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ date: string | null; items: TrendRadarNewsDto[]; total: number }> {
  const [dateRows] = await db.query<RowDataPacket[]>(
    `SELECT MAX(report_date) AS latest FROM trendradar_news`,
  );
  const latest = (dateRows[0] as { latest?: string | null } | undefined)?.latest ?? null;
  if (!latest) return { date: null, items: [], total: 0 };

  const data = await listTrendRadarNews({
    date: String(latest),
    platform: params.platform ?? null,
    keyword: params.keyword ?? null,
    limit: params.limit,
    offset: params.offset,
  });
  return { date: String(latest), ...data };
}