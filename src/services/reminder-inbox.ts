import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  formatDbDateTimeForApi,
  formatUtcMySQLDateTime,
  parseDbDateTimeToInstantInMode,
} from './calendar/logical-day.js';
import { DEFAULT_SYNC_USER_ID } from './sync-change-log.js';
import { nowUtcMysql } from './points-wallet.js';

export class ReminderInboxError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ReminderInboxError';
  }
}

export type ReminderInboxItemDto = {
  id: string;
  dedupeKey: string;
  category: string;
  title: string;
  body: string;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
};

export type ReminderInboxPageDto = {
  items: ReminderInboxItemDto[];
  nextCursor: string | null;
};

type InboxRow = {
  id: string;
  user_id: string;
  dedupe_key: string;
  category: string;
  title: string;
  body: string;
  payload_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  read_at: Date | string | null;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

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

function parsePayload(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return { raw };
    }
  }
  return raw;
}

function mapRow(row: InboxRow): ReminderInboxItemDto {
  return {
    id: String(row.id),
    dedupeKey: String(row.dedupe_key ?? ''),
    category: String(row.category ?? ''),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    payload: parsePayload(row.payload_json),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
    readAt: toIso(row.read_at),
  };
}

function serializePayload(payload: unknown): string | null {
  if (payload == null) return null;
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

/**
 * 派发时写入：同 dedupe_key 覆盖并重新未读。
 */
export async function upsertReminderInboxFromDispatch(params: {
  userId: string;
  dedupeKey: string;
  category: string;
  title: string;
  body: string;
  payload?: unknown;
}): Promise<ReminderInboxItemDto | null> {
  const userId = resolveUserId(params.userId);
  const dedupeKey = String(params.dedupeKey ?? '').trim();
  if (!dedupeKey) return null;
  const category = String(params.category ?? '').trim() || 'unknown';
  const title = String(params.title ?? '').trim() || '提醒';
  const body = String(params.body ?? '');
  const payloadJson = serializePayload(params.payload ?? null);
  const now = nowUtcMysql();
  const id = randomUUID();

  await db.query<ResultSetHeader>(
    `INSERT INTO reminder_inbox (
       id, user_id, dedupe_key, category, title, body, payload_json,
       created_at, updated_at, read_at
     ) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       category = VALUES(category),
       title = VALUES(title),
       body = VALUES(body),
       payload_json = VALUES(payload_json),
       created_at = VALUES(created_at),
       updated_at = VALUES(updated_at),
       read_at = NULL`,
    [id, userId, dedupeKey, category, title, body, payloadJson, now, now],
  );

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, dedupe_key, category, title, body, payload_json,
            created_at, updated_at, read_at
     FROM reminder_inbox
     WHERE user_id = ? AND dedupe_key = ?
     LIMIT 1`,
    [userId, dedupeKey],
  );
  const row = (rows?.[0] as InboxRow | undefined) ?? null;
  return row ? mapRow(row) : null;
}

export async function listReminderInbox(params: {
  userId?: string | null;
  cursor?: string | null;
  limit?: number;
  updatedSince?: string | null;
}): Promise<ReminderInboxPageDto> {
  const userId = resolveUserId(params.userId);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)),
  );

  const where: string[] = ['user_id = ?'];
  const values: unknown[] = [userId];

  const updatedSinceRaw = String(params.updatedSince ?? '').trim();
  if (updatedSinceRaw) {
    const ms = Date.parse(updatedSinceRaw);
    if (Number.isFinite(ms)) {
      where.push('updated_at >= ?');
      values.push(formatUtcMySQLDateTime(new Date(ms)));
    }
  }

  let cursorUpdatedAt: string | null = null;
  let cursorId: string | null = null;
  const rawCursor = String(params.cursor ?? '').trim();
  if (rawCursor) {
    const sep = rawCursor.indexOf('|');
    if (sep > 0) {
      cursorUpdatedAt = rawCursor.slice(0, sep);
      cursorId = rawCursor.slice(sep + 1);
    }
  }
  if (cursorUpdatedAt && cursorId) {
    where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    values.push(cursorUpdatedAt, cursorUpdatedAt, cursorId);
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, dedupe_key, category, title, body, payload_json,
            created_at, updated_at, read_at
     FROM reminder_inbox
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, id DESC
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
    const instant = parseDbDateTimeToInstantInMode(last.updated_at, 'utc');
    const rawUpdated = instant
      ? formatUtcMySQLDateTime(instant)
      : String(last.updated_at).replace('T', ' ').replace(/Z$/, '').slice(0, 23);
    nextCursor = `${rawUpdated}|${last.id}`;
  }

  return { items, nextCursor };
}

export async function markReminderInboxRead(params: {
  userId?: string | null;
  id?: string | null;
  dedupeKey?: string | null;
}): Promise<ReminderInboxItemDto> {
  const userId = resolveUserId(params.userId);
  const id = String(params.id ?? '').trim();
  const dedupeKey = String(params.dedupeKey ?? '').trim();
  if (!id && !dedupeKey) throw new ReminderInboxError('缺少 id 或 dedupeKey', 400);

  const [existingRows] = await db.query<RowDataPacket[]>(
    id
      ? `SELECT id, user_id, dedupe_key, category, title, body, payload_json,
                created_at, updated_at, read_at
         FROM reminder_inbox WHERE id = ? AND user_id = ? LIMIT 1`
      : `SELECT id, user_id, dedupe_key, category, title, body, payload_json,
                created_at, updated_at, read_at
         FROM reminder_inbox WHERE dedupe_key = ? AND user_id = ? LIMIT 1`,
    id ? [id, userId] : [dedupeKey, userId],
  );
  const existing = (existingRows?.[0] as InboxRow | undefined) ?? null;
  if (!existing) throw new ReminderInboxError('提醒不存在', 404);

  if (existing.read_at == null) {
    const now = nowUtcMysql();
    await db.query<ResultSetHeader>(
      `UPDATE reminder_inbox
       SET read_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND read_at IS NULL`,
      [now, now, existing.id, userId],
    );
    existing.read_at = now;
    existing.updated_at = now;
  }

  return mapRow(existing);
}

export async function markAllReminderInboxRead(params: {
  userId?: string | null;
}): Promise<{ updated: number }> {
  const userId = resolveUserId(params.userId);
  const now = nowUtcMysql();
  const [result] = await db.query<ResultSetHeader>(
    `UPDATE reminder_inbox
     SET read_at = ?, updated_at = ?
     WHERE user_id = ? AND read_at IS NULL`,
    [now, now, userId],
  );
  return { updated: result?.affectedRows ?? 0 };
}
