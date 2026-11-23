import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  formatDbDateTimeForApi,
  formatUtcMySQLDateTime,
} from './calendar/logical-day.js';
import { DEFAULT_SYNC_USER_ID } from './sync-change-log.js';
import { nowUtcMysql } from './points-wallet.js';

export class ReminderJobsError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ReminderJobsError';
  }
}

export type ReminderJobStatus = 'pending' | 'sent' | 'cancelled' | 'skipped';

export type ReminderJobUpsertInput = {
  dedupeKey: string;
  category: string;
  fireAt: string;
  title: string;
  body?: string;
  payload?: unknown;
  strong?: boolean;
};

function resolveUserId(userId?: string | null): string {
  const t = String(userId ?? '').trim();
  return t || DEFAULT_SYNC_USER_ID;
}

function toMysqlUtc(isoOrDate: string): string | null {
  const t = Date.parse(isoOrDate);
  if (!Number.isFinite(t)) return null;
  return formatUtcMySQLDateTime(new Date(t));
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
 * 批量 upsert pending jobs；可选按 category 对齐未出现在 upsert 中的 pending。
 * cancelDedupeKeys / cancelPrefixes：把匹配的 pending 标 cancelled。
 *
 * 顺序：先 cancel → 再 upsert → 最后 replaceCategories。
 * （同请求里 cancel+upsert 同一 dedupe_key 时，旧实现先 upsert 再 cancel 会把新 job 一并取消。）
 * upsert 时会先清掉该 dedupe_key 下其它 pending（含不同 fire_at），避免改点后双飞。
 */
export async function putReminderJobs(params: {
  userId?: string | null;
  upsert?: ReminderJobUpsertInput[];
  cancelDedupeKeys?: string[];
  cancelPrefixes?: string[];
  /** 若提供：这些 category 下未出现在本次 upsert 的 pending 全部 cancelled */
  replaceCategories?: string[];
}): Promise<{ upserted: number; cancelled: number }> {
  const userId = resolveUserId(params.userId);
  const now = nowUtcMysql();
  let upserted = 0;
  let cancelled = 0;

  const upsertList = Array.isArray(params.upsert) ? params.upsert : [];
  const keptKeys = new Set<string>();

  const cancelKeys = [
    ...new Set(
      (params.cancelDedupeKeys ?? [])
        .map(k => String(k ?? '').trim())
        .filter(Boolean),
    ),
  ];
  if (cancelKeys.length > 0) {
    const placeholders = cancelKeys.map(() => '?').join(',');
    const [result] = await db.query<ResultSetHeader>(
      `UPDATE reminder_jobs
       SET status = 'cancelled', updated_at = ?
       WHERE user_id = ? AND status = 'pending' AND dedupe_key IN (${placeholders})`,
      [now, userId, ...cancelKeys],
    );
    cancelled += result?.affectedRows ?? 0;
  }

  const prefixes = [
    ...new Set(
      (params.cancelPrefixes ?? [])
        .map(p => String(p ?? '').trim())
        .filter(Boolean),
    ),
  ];
  for (const prefix of prefixes) {
    const [result] = await db.query<ResultSetHeader>(
      `UPDATE reminder_jobs
       SET status = 'cancelled', updated_at = ?
       WHERE user_id = ? AND status = 'pending' AND dedupe_key LIKE ?`,
      [now, userId, `${prefix}%`],
    );
    cancelled += result?.affectedRows ?? 0;
  }

  for (const raw of upsertList) {
    const dedupeKey = String(raw?.dedupeKey ?? '').trim();
    const category = String(raw?.category ?? '').trim();
    const fireAtIso = String(raw?.fireAt ?? '').trim();
    const title = String(raw?.title ?? '').trim() || '提醒';
    const body = String(raw?.body ?? '');
    if (!dedupeKey || !category || !fireAtIso) continue;
    const fireAt = toMysqlUtc(fireAtIso);
    if (!fireAt) continue;
    const strong = raw?.strong === true ? 1 : 0;
    const payloadJson = serializePayload(raw?.payload ?? null);
    const id = randomUUID();

    keptKeys.add(`${category}\0${dedupeKey}`);

    // 唯一键含 fire_at：改主波 fireAt 时清掉其它「主波」pending，保留 escalationWave>0 的 follow-up
    const [cancelStale] = await db.query<ResultSetHeader>(
      `UPDATE reminder_jobs
       SET status = 'cancelled', updated_at = ?
       WHERE user_id = ? AND status = 'pending' AND dedupe_key = ? AND fire_at <> ?
         AND (
           payload_json IS NULL
           OR JSON_EXTRACT(payload_json, '$.escalationWave') IS NULL
           OR JSON_EXTRACT(payload_json, '$.escalationWave') = 0
         )`,
      [now, userId, dedupeKey, fireAt],
    );
    cancelled += cancelStale?.affectedRows ?? 0;

    await db.query<ResultSetHeader>(
      `INSERT INTO reminder_jobs (
         id, user_id, dedupe_key, category, fire_at, title, body,
         payload_json, status, strong, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'pending', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         category = VALUES(category),
         fire_at = VALUES(fire_at),
         title = IF(status = 'sent', title, VALUES(title)),
         body = IF(status = 'sent', body, VALUES(body)),
         payload_json = IF(status = 'sent', payload_json, VALUES(payload_json)),
         status = IF(status = 'sent', 'sent', 'pending'),
         strong = IF(status = 'sent', strong, VALUES(strong)),
         updated_at = VALUES(updated_at)`,
      [id, userId, dedupeKey, category, fireAt, title, body, payloadJson, strong, now, now],
    );
    upserted += 1;
  }

  const replaceCategories = [
    ...new Set(
      (params.replaceCategories ?? [])
        .map(c => String(c ?? '').trim())
        .filter(Boolean),
    ),
  ];
  if (replaceCategories.length > 0) {
    const keptDedupeByCategory = new Map<string, string[]>();
    for (const key of keptKeys) {
      const sep = key.indexOf('\0');
      const cat = key.slice(0, sep);
      const dk = key.slice(sep + 1);
      if (!replaceCategories.includes(cat)) continue;
      const list = keptDedupeByCategory.get(cat) ?? [];
      list.push(dk);
      keptDedupeByCategory.set(cat, list);
    }

    for (const cat of replaceCategories) {
      const keep = keptDedupeByCategory.get(cat) ?? [];
      if (keep.length === 0) {
        const [result] = await db.query<ResultSetHeader>(
          `UPDATE reminder_jobs
           SET status = 'cancelled', updated_at = ?
           WHERE user_id = ? AND status = 'pending' AND category = ?`,
          [now, userId, cat],
        );
        cancelled += result?.affectedRows ?? 0;
      } else {
        const placeholders = keep.map(() => '?').join(',');
        const [result] = await db.query<ResultSetHeader>(
          `UPDATE reminder_jobs
           SET status = 'cancelled', updated_at = ?
           WHERE user_id = ? AND status = 'pending' AND category = ?
             AND dedupe_key NOT IN (${placeholders})`,
          [now, userId, cat, ...keep],
        );
        cancelled += result?.affectedRows ?? 0;
      }
    }
  }

  return { upserted, cancelled };
}

export type DueReminderJobRow = {
  id: string;
  user_id: string;
  dedupe_key: string;
  category: string;
  fire_at: Date | string;
  title: string;
  body: string;
  payload_json: unknown;
  strong: number;
};

/** 领取一批 due pending（按 fire_at 升序） */
export async function listDueReminderJobs(limit = 50): Promise<DueReminderJobRow[]> {
  const now = nowUtcMysql();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, dedupe_key, category, fire_at, title, body, payload_json, strong
     FROM reminder_jobs
     WHERE status = 'pending' AND fire_at <= ?
     ORDER BY fire_at ASC
     LIMIT ?`,
    [now, Math.max(1, Math.min(200, Math.floor(limit)))],
  );
  return (rows ?? []) as DueReminderJobRow[];
}

export async function markReminderJobStatus(
  id: string,
  status: ReminderJobStatus,
): Promise<void> {
  const jobId = String(id ?? '').trim();
  if (!jobId) return;
  const now = nowUtcMysql();
  await db.query<ResultSetHeader>(
    `UPDATE reminder_jobs SET status = ?, updated_at = ? WHERE id = ?`,
    [status, now, jobId],
  );
}

/** 派发强提醒时插入 follow-up escalation job（同一 dedupe_key、不同 fire_at） */
export async function insertFollowUpReminderJob(params: {
  userId: string;
  dedupeKey: string;
  category: string;
  fireAt: Date;
  title: string;
  body: string;
  payload: unknown;
  strong?: boolean;
}): Promise<void> {
  const fireAt = formatUtcMySQLDateTime(params.fireAt);
  const now = nowUtcMysql();
  const id = randomUUID();
  const payloadJson = serializePayload(params.payload);
  await db.query<ResultSetHeader>(
    `INSERT INTO reminder_jobs (
       id, user_id, dedupe_key, category, fire_at, title, body,
       payload_json, status, strong, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'pending', ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       category = VALUES(category),
       fire_at = VALUES(fire_at),
       title = VALUES(title),
       body = VALUES(body),
       payload_json = VALUES(payload_json),
       status = 'pending',
       strong = VALUES(strong),
       updated_at = VALUES(updated_at)`,
    [
      id,
      params.userId,
      params.dedupeKey,
      params.category,
      fireAt,
      params.title,
      params.body,
      payloadJson,
      params.strong === false ? 0 : 1,
      now,
      now,
    ],
  );
}

export function formatJobFireAtIso(value: Date | string): string {
  const formatted = formatDbDateTimeForApi(value, 'utc');
  if (formatted) return formatted;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return String(value);
}
