import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  formatDbDateTimeForApi,
  formatUtcMySQLDateTime,
  parseDbDateTimeToInstantInMode,
} from './calendar/logical-day.js';
import { DEFAULT_SYNC_USER_ID } from './sync-change-log.js';
import { nowUtcMysql } from './points-wallet.js';

/**
 * 资讯 / 采集收件箱服务。
 *
 * 未来由采集任务 INSERT；本期仅提供列表与已读，默认可返回空。
 * 扩展预留：
 * 1. 后台配置扫描 URL → Worker 抓取 → INSERT app_inbox
 * 2. App 拉取后进「资讯」Tab；未读进铃铛数字
 * 3. module=health 等本期仍不打业务 Tab 角标
 */

export class AppInboxError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'AppInboxError';
  }
}

/** 与 App `RemoteInboxItem` 对齐的 camelCase DTO */
export type AppInboxItemDto = {
  id: string;
  title: string;
  body: string;
  module: string;
  href: string | null;
  sourceKey: string | null;
  createdAt: string;
  readAt: string | null;
  /** 兼容 App 旧字段：等同 href */
  sourceUrl: string | null;
};

export type AppInboxPageDto = {
  items: AppInboxItemDto[];
  nextCursor: string | null;
};

type InboxRow = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  module: string;
  href: string | null;
  source_key: string | null;
  payload_json: unknown;
  created_at: Date | string;
  read_at: Date | string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function resolveUserId(userId?: string | null): string {
  const t = String(userId ?? '').trim();
  return t || DEFAULT_SYNC_USER_ID;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const formatted = formatDbDateTimeForApi(value, 'utc');
  if (formatted) return formatted;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  const s = String(value);
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}

function mapRow(row: InboxRow): AppInboxItemDto {
  const href = row.href != null && String(row.href).trim() ? String(row.href) : null;
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    module: String(row.module ?? 'messages'),
    href,
    sourceKey:
      row.source_key != null && String(row.source_key).trim()
        ? String(row.source_key)
        : null,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    readAt: toIso(row.read_at),
    sourceUrl: href,
  };
}

/**
 * 游标分页：cursor = 上一页最后一条的 created_at|id（ISO|id）。
 * 无数据 → `{ items: [], nextCursor: null }`。
 */
export async function listAppInbox(params: {
  userId?: string | null;
  cursor?: string | null;
  limit?: number;
}): Promise<AppInboxPageDto> {
  const userId = resolveUserId(params.userId);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)),
  );

  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  const rawCursor = String(params.cursor ?? '').trim();
  if (rawCursor) {
    const sep = rawCursor.indexOf('|');
    if (sep > 0) {
      cursorCreatedAt = rawCursor.slice(0, sep);
      cursorId = rawCursor.slice(sep + 1);
    }
  }

  const where: string[] = ['user_id = ?'];
  const values: unknown[] = [userId];
  if (cursorCreatedAt && cursorId) {
    // created_at DESC, id DESC
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    values.push(cursorCreatedAt, cursorCreatedAt, cursorId);
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, title, body, module, href, source_key, payload_json, created_at, read_at
     FROM app_inbox
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...values, limit + 1],
  );

  const list = (rows ?? []) as InboxRow[];
  const hasMore = list.length > limit;
  const page = hasMore ? list.slice(0, limit) : list;
  const items = page.map(mapRow);

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    const instant = parseDbDateTimeToInstantInMode(last.created_at, 'utc');
    const rawCreated = instant
      ? formatUtcMySQLDateTime(instant)
      : String(last.created_at).replace('T', ' ').replace(/Z$/, '').slice(0, 19);
    nextCursor = `${rawCreated}|${last.id}`;
  }

  return { items, nextCursor };
}

/** 将该条 read_at=now；不存在 → 404 */
export async function markAppInboxRead(params: {
  userId?: string | null;
  id: string;
}): Promise<AppInboxItemDto> {
  const userId = resolveUserId(params.userId);
  const id = String(params.id ?? '').trim();
  if (!id) throw new AppInboxError('缺少资讯 id', 400);

  const [existingRows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, title, body, module, href, source_key, payload_json, created_at, read_at
     FROM app_inbox WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId],
  );
  const existing = (existingRows?.[0] as InboxRow | undefined) ?? null;
  if (!existing) throw new AppInboxError('资讯不存在', 404);

  if (existing.read_at == null) {
    const now = nowUtcMysql();
    await db.query<ResultSetHeader>(
      `UPDATE app_inbox SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`,
      [now, id, userId],
    );
    existing.read_at = now;
  }

  return mapRow(existing);
}

/** 当前用户未读全部已读 */
export async function markAllAppInboxRead(params: {
  userId?: string | null;
}): Promise<{ updated: number }> {
  const userId = resolveUserId(params.userId);
  const now = nowUtcMysql();
  const [result] = await db.query<ResultSetHeader>(
    `UPDATE app_inbox SET read_at = ? WHERE user_id = ? AND read_at IS NULL`,
    [now, userId],
  );
  return { updated: result?.affectedRows ?? 0 };
}
