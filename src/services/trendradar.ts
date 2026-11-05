import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { computeNewsUrlHash, sha1Hex } from '../utils/trendradar-dedupe.js';
import { normalizeTrendRadarUrl } from '../utils/trendradar-url.js';
import { formatUtcMySQLDateTime } from './calendar/logical-day.js';
import { nowUtcMysql } from './points-wallet.js';

/**
 * TrendRadar 推送解析与入库。
 *
 * 官方推送方式：通用 Webhook（GENERIC_WEBHOOK_URL），
 * body 固定为 { title: '当前榜单' | '当日汇总' | '增量监控' | ..., content: Markdown }，
 * 长报告会按 4000 字节左右切分为「第 N/M 批次」多次 POST。
 *
 * 这里把 Markdown 解析为结构化条目落库，同时保留每批原文便于重放。
 */

export class TrendRadarError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'TrendRadarError';
  }
}

export type TrendRadarSectionKind = 'hotlist' | 'rss';

export type TrendRadarNewsItem = {
  section: TrendRadarSectionKind;
  keywordGroup: string;
  groupSeq: number | null;
  groupTotal: number | null;
  groupCount: number | null;
  seqNo: number | null;
  platformName: string;
  title: string;
  url: string | null;
  rankNo: number | null;
  rankEnd: number | null;
  rankTrend: 'up' | 'down' | null;
  appearTime: string | null;
  crawlCount: number | null;
  isNew: boolean;
};

export type ParsedTrendRadar = {
  modeLabel: string | null;
  mode: 'current' | 'daily' | 'incremental' | null;
  reportTimeLocal: string | null;
  batchIndex: number | null;
  batchTotal: number | null;
  totalNews: number | null;
  newNews: number | null;
  hotlistMatched: number | null;
  hotlistTotal: number | null;
  platformOk: number | null;
  platformTotal: number | null;
  rssMatched: number | null;
  rssTotal: number | null;
  rssSourceOk: number | null;
  rssSourceTotal: number | null;
  topTopics: string | null;
  items: TrendRadarNewsItem[];
};

const MODE_MAP: Record<string, 'current' | 'daily' | 'incremental'> = {
  当前榜单: 'current',
  当日汇总: 'daily',
  增量监控: 'incremental',
};

const BATCH_RE = /^\*\*\[第\s*(\d+)\s*\/\s*(\d+)\s*批次\]\*\*/;
const TOTAL_NEWS_RE = /^\*\*总新闻：\*\*\s*(\d+)\s*条（新增\s*(\d+)\s*\+\s*(\d+)）/;
const HOTLIST_RE = /^\*\*热榜：\*\*\s*(\d+)\/(\d+)（平台\s*(\d+)\/(\d+)）/;
const RSS_HEADER_RE = /^\*\*RSS：\*\*\s*(\d+)\/(\d+)（源\s*(\d+)\/(\d+)）/;
const TYPE_RE = /^\*\*类型：\*\*\s*(.+)$/;
const TIME_RE = /^\*\*时间：\*\*\s*(.+)$/;
const TOPICS_RE = /^\*\*最热话题：\*\*\s*(.+)$/;
const SECTION_RE = /^(?:📊|📰)\s*\*\*(热点词汇统计|热点新闻统计|RSS 订阅统计)\*\*\s*\(共\s*(\d+)\s*条\)/u;
const GROUP_RE = /^[🔥📈📌]\s*\[(\d+)\/(\d+)\]\s+\*\*(.+?)\*\*\s*:\s*\*{0,2}(\d+)\*{0,2}\s*条/u;
const ITEM_RE = /^\s*(\d+)\.\s+\[([^\]]+)\]\s+(?:🆕\s+)?\[(.+?)\]\((https?:\/\/[^\s)]+)\)\s*(.*)$/u;
const FOOTER_RE = /^>\s*更新时间：(.+)$/;

function toInt(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Asia/Shanghai 墙上时间 → UTC 'YYYY-MM-DD HH:mm:ss' */
export function shanghaiToUtcMysql(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return formatUtcMySQLDateTime(new Date(ms));
}

/** UTC 毫秒 → Asia/Shanghai 'YYYY-MM-DD' */
export function shanghaiDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function parseItemRest(rest: string, item: TrendRadarNewsItem): void {
  let r = rest.trim();
  const rankM = /^\*{0,2}\[(\d+)(?:\s*-\s*(\d+))?\]\*{0,2}/.exec(r);
  if (rankM) {
    item.rankNo = toInt(rankM[1]);
    item.rankEnd = toInt(rankM[2]);
    r = r.slice(rankM[0].length).trim();
  }
  const trendM = /^(📈|📉)\s*/u.exec(r);
  if (trendM) {
    item.rankTrend = trendM[1] === '📈' ? 'up' : 'down';
    r = r.slice(trendM[0].length).trim();
  }
  const countM = /\((\d+)\s*次\)/.exec(r);
  if (countM) item.crawlCount = toInt(countM[1]);
  const rangeM = /\[([^\]]+)\]/.exec(r);
  if (rangeM) {
    item.appearTime = rangeM[1].trim();
  } else {
    const tail = r.replace(/^-\s*/, '').replace(/\((\d+)\s*次\)/, '').trim();
    if (tail) item.appearTime = tail;
  }
}

/**
 * 解析单个 webhook 批次的 Markdown。纯函数，无 IO，便于自测。
 */
export function parseTrendRadarMarkdown(
  content: string,
  payloadTitle = '',
): ParsedTrendRadar {
  const parsed: ParsedTrendRadar = {
    modeLabel: null,
    mode: null,
    reportTimeLocal: null,
    batchIndex: null,
    batchTotal: null,
    totalNews: null,
    newNews: null,
    hotlistMatched: null,
    hotlistTotal: null,
    platformOk: null,
    platformTotal: null,
    rssMatched: null,
    rssTotal: null,
    rssSourceOk: null,
    rssSourceTotal: null,
    topTopics: null,
    items: [],
  };

  let section: TrendRadarSectionKind = 'hotlist';
  let group: {
    keyword: string;
    seq: number | null;
    total: number | null;
    count: number | null;
  } | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    let m = BATCH_RE.exec(line.trim());
    if (m) {
      parsed.batchIndex = toInt(m[1]);
      parsed.batchTotal = toInt(m[2]);
      continue;
    }
    m = TOTAL_NEWS_RE.exec(line.trim());
    if (m) {
      parsed.totalNews = toInt(m[1]);
      parsed.newNews = toInt(m[2]);
      continue;
    }
    m = HOTLIST_RE.exec(line.trim());
    if (m) {
      parsed.hotlistMatched = toInt(m[1]);
      parsed.hotlistTotal = toInt(m[2]);
      parsed.platformOk = toInt(m[3]);
      parsed.platformTotal = toInt(m[4]);
      continue;
    }
    m = RSS_HEADER_RE.exec(line.trim());
    if (m) {
      parsed.rssMatched = toInt(m[1]);
      parsed.rssTotal = toInt(m[2]);
      parsed.rssSourceOk = toInt(m[3]);
      parsed.rssSourceTotal = toInt(m[4]);
      continue;
    }
    m = TYPE_RE.exec(line.trim());
    if (m) {
      parsed.modeLabel = m[1].trim();
      parsed.mode = MODE_MAP[parsed.modeLabel] ?? null;
      continue;
    }
    m = TIME_RE.exec(line.trim());
    if (m) {
      parsed.reportTimeLocal = m[1].trim();
      continue;
    }
    m = TOPICS_RE.exec(line.trim());
    if (m) {
      parsed.topTopics = m[1].trim().slice(0, 512);
      continue;
    }
    m = FOOTER_RE.exec(line.trim());
    if (m && !parsed.reportTimeLocal) {
      parsed.reportTimeLocal = m[1].trim();
      continue;
    }
    m = SECTION_RE.exec(line.trim());
    if (m) {
      section = m[1] === 'RSS 订阅统计' ? 'rss' : 'hotlist';
      group = null;
      continue;
    }
    m = GROUP_RE.exec(line.trim());
    if (m) {
      group = {
        seq: toInt(m[1]),
        total: toInt(m[2]),
        keyword: m[3].trim().slice(0, 255),
        count: toInt(m[4]),
      };
      continue;
    }
    m = ITEM_RE.exec(line);
    if (m) {
      const item: TrendRadarNewsItem = {
        section,
        keywordGroup: group?.keyword ?? '',
        groupSeq: group?.seq ?? null,
        groupTotal: group?.total ?? null,
        groupCount: group?.count ?? null,
        seqNo: toInt(m[1]),
        platformName: m[2].trim().slice(0, 64),
        title: m[3].trim().slice(0, 512),
        url: m[4].trim().slice(0, 1024),
        rankNo: null,
        rankEnd: null,
        rankTrend: null,
        appearTime: null,
        crawlCount: null,
        isNew: /🆕/.test(m[0]),
      };
      parseItemRest(m[5] ?? '', item);
      parsed.items.push(item);
      continue;
    }
  }

  if (!parsed.modeLabel && payloadTitle) {
    parsed.modeLabel = payloadTitle.trim().slice(0, 32);
    parsed.mode = MODE_MAP[parsed.modeLabel] ?? null;
  }

  return parsed;
}

function sha1(text: string): string {
  return sha1Hex(text);
}

export type TrendRadarIngestResult = {
  reportId: number;
  reportTime: string;
  reportDate: string;
  batchIndex: number;
  batchTotal: number;
  itemsParsed: number;
  itemsStored: number;
};

/**
 * 接收一次 webhook 推送并落库（幂等：同一报告的同一批次重复推送不会重复计数）。
 */
export async function ingestTrendRadarWebhook(
  payload: { title?: unknown; content?: unknown },
): Promise<TrendRadarIngestResult> {
  const content = typeof payload.content === 'string' ? payload.content : '';
  if (!content.trim()) {
    throw new TrendRadarError('content 为空', 400);
  }
  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 64) : '';

  const parsed = parseTrendRadarMarkdown(content, title);

  const now = nowUtcMysql();
  const reportTimeUtc =
    (parsed.reportTimeLocal && shanghaiToUtcMysql(parsed.reportTimeLocal)) || now;
  const reportDate =
    (parsed.reportTimeLocal &&
      /^(\d{4}-\d{2}-\d{2})/.exec(parsed.reportTimeLocal)?.[1]) ||
    shanghaiDate(Date.parse(`${reportTimeUtc.replace(' ', 'T')}Z`));
  const batchIndex = parsed.batchIndex ?? 1;
  const batchTotal = parsed.batchTotal ?? 1;
  const modeLabel = parsed.modeLabel ?? (title || 'unknown');

  const [reportResult] = await db.query<ResultSetHeader>(
    `INSERT INTO trendradar_report
       (mode, mode_label, report_time, report_date, batch_total, batch_received, item_count,
        total_news, new_news, hotlist_matched, hotlist_total, platform_ok, platform_total,
        rss_matched, rss_total, rss_source_ok, rss_source_total, top_topics,
        first_received_at, last_received_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       mode = COALESCE(VALUES(mode), mode),
       batch_total = GREATEST(batch_total, VALUES(batch_total)),
       total_news = COALESCE(VALUES(total_news), total_news),
       new_news = COALESCE(VALUES(new_news), new_news),
       hotlist_matched = COALESCE(VALUES(hotlist_matched), hotlist_matched),
       hotlist_total = COALESCE(VALUES(hotlist_total), hotlist_total),
       platform_ok = COALESCE(VALUES(platform_ok), platform_ok),
       platform_total = COALESCE(VALUES(platform_total), platform_total),
       rss_matched = COALESCE(VALUES(rss_matched), rss_matched),
       rss_total = COALESCE(VALUES(rss_total), rss_total),
       rss_source_ok = COALESCE(VALUES(rss_source_ok), rss_source_ok),
       rss_source_total = COALESCE(VALUES(rss_source_total), rss_source_total),
       top_topics = COALESCE(VALUES(top_topics), top_topics),
       last_received_at = VALUES(last_received_at)`,
    [
      parsed.mode,
      modeLabel,
      reportTimeUtc,
      reportDate,
      batchTotal,
      parsed.totalNews,
      parsed.newNews,
      parsed.hotlistMatched,
      parsed.hotlistTotal,
      parsed.platformOk,
      parsed.platformTotal,
      parsed.rssMatched,
      parsed.rssTotal,
      parsed.rssSourceOk,
      parsed.rssSourceTotal,
      parsed.topTopics,
      now,
      now,
    ],
  );
  const reportId = reportResult.insertId;
  if (!reportId) throw new TrendRadarError('报告写入失败', 500);

  await db.query<ResultSetHeader>(
    `INSERT INTO trendradar_report_batch
       (report_id, batch_index, batch_total, content_sha1, title, content, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       batch_total = VALUES(batch_total),
       content_sha1 = VALUES(content_sha1),
       title = VALUES(title),
       content = VALUES(content),
       received_at = VALUES(received_at)`,
    [reportId, batchIndex, batchTotal, sha1(content), title, content, now],
  );

  let itemsStored = 0;
  if (parsed.items.length > 0) {
    const rows = parsed.items.map((item) => {
      const rawUrl = item.url?.trim() || '';
      const url = rawUrl ? normalizeTrendRadarUrl(rawUrl) || rawUrl : null;
      return [
        reportId,
        reportDate,
        item.section,
        item.keywordGroup,
        item.groupSeq,
        item.groupTotal,
        item.groupCount,
        item.seqNo,
        item.platformName,
        item.title,
        url,
        computeNewsUrlHash(url),
        item.rankNo,
        item.rankEnd,
        item.rankTrend,
        item.appearTime,
        item.crawlCount,
        item.isNew ? 1 : 0,
      ];
    });
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const [res] = await db.query<ResultSetHeader>(
        `INSERT INTO trendradar_news
           (report_id, report_date, section, keyword_group, group_seq, group_total, group_count,
            seq_no, platform_name, title, url, url_hash, rank_no, rank_end, rank_trend,
            appear_time, crawl_count, is_new)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           report_id = VALUES(report_id),
           keyword_group = IF(VALUES(keyword_group) <> '', VALUES(keyword_group), keyword_group),
           group_seq = COALESCE(VALUES(group_seq), group_seq),
           group_total = COALESCE(VALUES(group_total), group_total),
           group_count = COALESCE(VALUES(group_count), group_count),
           seq_no = COALESCE(VALUES(seq_no), seq_no),
           title = VALUES(title),
           url = COALESCE(VALUES(url), url),
           rank_no = COALESCE(VALUES(rank_no), rank_no),
           rank_end = COALESCE(VALUES(rank_end), rank_end),
           rank_trend = COALESCE(VALUES(rank_trend), rank_trend),
           appear_time = COALESCE(VALUES(appear_time), appear_time),
           crawl_count = COALESCE(VALUES(crawl_count), crawl_count),
           is_new = GREATEST(is_new, VALUES(is_new))`,
        [rows.slice(i, i + CHUNK)],
      );
      itemsStored += res.affectedRows ?? 0;
    }
  }

  await db.query(
    `UPDATE trendradar_report r
        SET batch_received = (SELECT COUNT(*) FROM trendradar_report_batch b WHERE b.report_id = r.id),
            item_count = (SELECT COUNT(*) FROM trendradar_news n WHERE n.report_id = r.id)
      WHERE r.id = ?`,
    [reportId],
  );

  return {
    reportId,
    reportTime: reportTimeUtc,
    reportDate,
    batchIndex,
    batchTotal,
    itemsParsed: parsed.items.length,
    itemsStored,
  };
}

export type TrendRadarReportDto = {
  id: number;
  mode: string | null;
  modeLabel: string | null;
  reportTime: string | null;
  reportDate: string | null;
  batchTotal: number;
  batchReceived: number;
  itemCount: number;
  totalNews: number | null;
  newNews: number | null;
  hotlistMatched: number | null;
  hotlistTotal: number | null;
  platformOk: number | null;
  platformTotal: number | null;
  rssMatched: number | null;
  rssTotal: number | null;
  rssSourceOk: number | null;
  rssSourceTotal: number | null;
  topTopics: string | null;
  lastReceivedAt: string | null;
};

type ReportRow = {
  id: number;
  mode: string | null;
  mode_label: string | null;
  report_time: string | null;
  report_date: string | null;
  batch_total: number;
  batch_received: number;
  item_count: number;
  total_news: number | null;
  new_news: number | null;
  hotlist_matched: number | null;
  hotlist_total: number | null;
  platform_ok: number | null;
  platform_total: number | null;
  rss_matched: number | null;
  rss_total: number | null;
  rss_source_ok: number | null;
  rss_source_total: number | null;
  top_topics: string | null;
  last_received_at: string | null;
};

function mapReport(row: ReportRow): TrendRadarReportDto {
  return {
    id: Number(row.id),
    mode: row.mode,
    modeLabel: row.mode_label,
    reportTime: row.report_time,
    reportDate: row.report_date,
    batchTotal: Number(row.batch_total ?? 0),
    batchReceived: Number(row.batch_received ?? 0),
    itemCount: Number(row.item_count ?? 0),
    totalNews: row.total_news,
    newNews: row.new_news,
    hotlistMatched: row.hotlist_matched,
    hotlistTotal: row.hotlist_total,
    platformOk: row.platform_ok,
    platformTotal: row.platform_total,
    rssMatched: row.rss_matched,
    rssTotal: row.rss_total,
    rssSourceOk: row.rss_source_ok,
    rssSourceTotal: row.rss_source_total,
    topTopics: row.top_topics,
    lastReceivedAt: row.last_received_at,
  };
}

export async function listTrendRadarReports(params: {
  date?: string | null;
  limit?: number;
}): Promise<TrendRadarReportDto[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(params.limit ?? 20)));
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    where.push('report_date = ?');
    values.push(params.date);
  }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, mode, mode_label, report_time, report_date, batch_total, batch_received,
            item_count, total_news, new_news, hotlist_matched, hotlist_total, platform_ok,
            platform_total, rss_matched, rss_total, rss_source_ok, rss_source_total,
            top_topics, last_received_at
       FROM trendradar_report
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY report_time DESC, id DESC
      LIMIT ?`,
    [...values, limit],
  );
  return (rows as ReportRow[]).map(mapReport);
}

export type TrendRadarNewsDto = {
  id: number;
  reportId: number;
  reportDate: string;
  section: string;
  keywordGroup: string;
  groupSeq: number | null;
  groupTotal: number | null;
  groupCount: number | null;
  seqNo: number | null;
  platformName: string;
  title: string;
  url: string | null;
  rankNo: number | null;
  rankEnd: number | null;
  rankTrend: string | null;
  appearTime: string | null;
  crawlCount: number | null;
  isNew: boolean;
};

type NewsRow = {
  id: number;
  report_id: number;
  report_date: string;
  section: string;
  keyword_group: string;
  group_seq: number | null;
  group_total: number | null;
  group_count: number | null;
  seq_no: number | null;
  platform_name: string;
  title: string;
  url: string | null;
  rank_no: number | null;
  rank_end: number | null;
  rank_trend: string | null;
  appear_time: string | null;
  crawl_count: number | null;
  is_new: number;
};

export async function listTrendRadarNews(params: {
  reportId?: number | null;
  date?: string | null;
  keyword?: string | null;
  platform?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ items: TrendRadarNewsDto[]; total: number }> {
  const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 100)));
  const offset = Math.max(0, Math.floor(params.offset ?? 0));

  const where: string[] = [];
  const values: unknown[] = [];
  if (params.reportId != null && Number.isFinite(params.reportId)) {
    where.push('report_id = ?');
    values.push(Math.trunc(params.reportId));
  }
  if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    where.push('report_date = ?');
    values.push(params.date);
  }
  if (params.keyword) {
    where.push('keyword_group LIKE ?');
    values.push(`%${params.keyword}%`);
  }
  if (params.platform) {
    where.push('platform_name LIKE ?');
    values.push(`%${params.platform}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM trendradar_news ${whereSql}`,
    values,
  );
  const total = Number((countRows[0] as { total?: number } | undefined)?.total ?? 0);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, report_id, report_date, section, keyword_group, group_seq, group_total,
            group_count, seq_no, platform_name, title, url, rank_no, rank_end, rank_trend,
            appear_time, crawl_count, is_new
       FROM trendradar_news
      ${whereSql}
      ORDER BY report_id DESC, section ASC, group_seq ASC, seq_no ASC
      LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );

  const items = (rows as NewsRow[]).map((row) => ({
    id: Number(row.id),
    reportId: Number(row.report_id),
    reportDate: row.report_date,
    section: row.section,
    keywordGroup: row.keyword_group,
    groupSeq: row.group_seq,
    groupTotal: row.group_total,
    groupCount: row.group_count,
    seqNo: row.seq_no,
    platformName: row.platform_name,
    title: row.title,
    url: row.url,
    rankNo: row.rank_no,
    rankEnd: row.rank_end,
    rankTrend: row.rank_trend,
    appearTime: row.appear_time,
    crawlCount: row.crawl_count,
    isNew: Number(row.is_new) === 1,
  }));

  return { items, total };
}