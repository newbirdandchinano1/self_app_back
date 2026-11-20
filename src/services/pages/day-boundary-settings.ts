/**
 * 逻辑日界专用读写（相对裸 app_settings CRUD 的语义 API）。
 * 键与 App `AppSettingKey.tasksCompletionDayStart` / `dayBoundaryPages` 对齐。
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import {
  DEFAULT_TASKS_DAY_BOUNDARY,
  formatUtcMySQLDateTime,
  normalizeTasksDayBoundary,
  type TasksDayBoundary,
} from '../calendar/logical-day.js';
import {
  DAY_BOUNDARY_APP_SETTING_KEYS,
  appendChangeLog,
  withSyncTransaction,
  type SyncWriteOptions,
} from '../sync-change-log.js';
import { stampLiveUpsert } from '../sync-revision.js';

export class DayBoundaryError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'DayBoundaryError';
  }
}

export type DayBoundaryPageId = 'health' | 'tasks' | 'finance' | 'review';

const PAGE_IDS: readonly DayBoundaryPageId[] = ['health', 'tasks', 'finance', 'review'];
const DEFAULT_PAGES: readonly DayBoundaryPageId[] = ['tasks', 'review'];

const KEY_BOUNDARY = '@tasks_completion_day_start_v1';
const KEY_PAGES = '@selfapp/day_boundary_pages_v1';

function parseJsonValue(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizePages(raw: unknown): DayBoundaryPageId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_PAGES];
  const seen = new Set<DayBoundaryPageId>();
  const out: DayBoundaryPageId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    if (!(PAGE_IDS as readonly string[]).includes(item)) continue;
    const id = item as DayBoundaryPageId;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function readSetting(key: string): Promise<unknown> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT value_json FROM app_settings WHERE `key` = ? LIMIT 1',
    [key],
  );
  return parseJsonValue(rows[0]?.value_json);
}

async function writeSettingWithChangeLog(
  key: string,
  value: unknown,
  options: SyncWriteOptions,
): Promise<void> {
  if (!DAY_BOUNDARY_APP_SETTING_KEYS.has(key)) {
    throw new DayBoundaryError(`不允许写入非日界设置键：${key}`);
  }
  const payload = JSON.stringify(value);
  const now = formatUtcMySQLDateTime(new Date());
  await withSyncTransaction(async (conn) => {
    await conn.query<ResultSetHeader>(
      `INSERT INTO app_settings (\`key\`, value_json, updated_at, sync_status)
       VALUES (?, ?, ?, 'synced')
       ON DUPLICATE KEY UPDATE
         value_json = VALUES(value_json),
         updated_at = VALUES(updated_at),
         sync_status = 'synced'`,
      [key, payload, now],
    );
    const stamp = await stampLiveUpsert(conn, 'app_settings', key, {
      mode: 'upsert',
      mutationId: options.mutationId,
      skipOcc: true,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'app_settings',
        recordPk: key,
        op: 'upsert',
        updatedAt: now,
        deviceId: options.deviceId,
        hint: { reason: 'day_boundary' },
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });
}

export type DayBoundarySettings = {
  /** 设置里配置的日界时刻（未必对所有页面生效） */
  configured: TasksDayBoundary;
  /** 采用自定义日界的页面 */
  pages: DayBoundaryPageId[];
  /** 任务域有效日界（未勾选 tasks 时为 0:00） */
  tasksEffective: TasksDayBoundary;
  keys: { boundary: string; pages: string };
};

export async function getDayBoundarySettings(): Promise<DayBoundarySettings> {
  const [rawBoundary, rawPages] = await Promise.all([
    readSetting(KEY_BOUNDARY),
    readSetting(KEY_PAGES),
  ]);
  const configured = normalizeTasksDayBoundary(rawBoundary ?? DEFAULT_TASKS_DAY_BOUNDARY);
  const pages = normalizePages(rawPages);
  const tasksEffective = pages.includes('tasks')
    ? configured
    : { ...DEFAULT_TASKS_DAY_BOUNDARY };
  return {
    configured,
    pages,
    tasksEffective,
    keys: { boundary: KEY_BOUNDARY, pages: KEY_PAGES },
  };
}

export type UpdateDayBoundaryInput = {
  hour?: unknown;
  minute?: unknown;
  pages?: unknown;
  /** 只改时刻、不改 pages */
  boundaryOnly?: boolean;
};

export async function updateDayBoundarySettings(
  input: UpdateDayBoundaryInput,
  options: SyncWriteOptions = {},
): Promise<DayBoundarySettings> {
  const current = await getDayBoundarySettings();
  const hasHour = Object.prototype.hasOwnProperty.call(input, 'hour');
  const hasMinute = Object.prototype.hasOwnProperty.call(input, 'minute');
  const hasPages = Object.prototype.hasOwnProperty.call(input, 'pages');

  if (!hasHour && !hasMinute && !hasPages) {
    throw new DayBoundaryError('请提供 hour/minute 或 pages');
  }

  if (hasHour || hasMinute) {
    const next = normalizeTasksDayBoundary({
      hour: hasHour ? input.hour : current.configured.hour,
      minute: hasMinute ? input.minute : current.configured.minute,
    });
    await writeSettingWithChangeLog(KEY_BOUNDARY, next, options);
  }

  if (hasPages && input.boundaryOnly !== true) {
    if (!Array.isArray(input.pages)) {
      throw new DayBoundaryError('pages 须为数组，如 ["tasks","review"]');
    }
    const pages = normalizePages(input.pages);
    await writeSettingWithChangeLog(KEY_PAGES, pages, options);
  }

  return getDayBoundarySettings();
}
