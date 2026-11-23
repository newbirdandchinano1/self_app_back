import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { DEFAULT_SYNC_USER_ID } from './sync-change-log.js';
import { nowUtcMysql } from './points-wallet.js';

export class DevicePushTokenError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'DevicePushTokenError';
  }
}

function resolveUserId(userId?: string | null): string {
  const t = String(userId ?? '').trim();
  return t || DEFAULT_SYNC_USER_ID;
}

export async function upsertDevicePushToken(params: {
  userId?: string | null;
  token: string;
  platform?: string | null;
}): Promise<{ id: string; token: string; platform: string }> {
  const userId = resolveUserId(params.userId);
  const token = String(params.token ?? '').trim();
  if (!token) throw new DevicePushTokenError('缺少 push token', 400);
  const platformRaw = String(params.platform ?? '').trim().toLowerCase();
  const platform =
    platformRaw === 'ios' || platformRaw === 'android' || platformRaw === 'web'
      ? platformRaw
      : 'unknown';
  const now = nowUtcMysql();

  const [existing] = await db.query<RowDataPacket[]>(
    `SELECT id FROM device_push_tokens WHERE token = ? LIMIT 1`,
    [token],
  );
  const row = existing?.[0] as { id?: string } | undefined;
  if (row?.id) {
    await db.query<ResultSetHeader>(
      `UPDATE device_push_tokens
       SET user_id = ?, platform = ?, updated_at = ?
       WHERE id = ?`,
      [userId, platform, now, row.id],
    );
    return { id: String(row.id), token, platform };
  }

  const id = randomUUID();
  await db.query<ResultSetHeader>(
    `INSERT INTO device_push_tokens (id, user_id, token, platform, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, userId, token, platform, now],
  );
  return { id, token, platform };
}

export async function listPushTokensForUser(userId?: string | null): Promise<string[]> {
  const uid = resolveUserId(userId);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT token FROM device_push_tokens WHERE user_id = ?`,
    [uid],
  );
  return (rows ?? [])
    .map(r => String((r as { token?: string }).token ?? '').trim())
    .filter(Boolean);
}

/** Expo 回报 DeviceNotRegistered 时删掉失效 token */
export async function deletePushToken(token: string): Promise<void> {
  const t = String(token ?? '').trim();
  if (!t) return;
  await db.query<ResultSetHeader>(`DELETE FROM device_push_tokens WHERE token = ?`, [t]);
}
