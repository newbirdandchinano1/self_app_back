import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  addDaysToYmd,
  formatLocalYmdFromDate,
  formatMySQLWallClockDateTime,
  formatRecordDateTimesForApi,
  normalizeDbDateTimeForTableStorage,
  parseYmd,
} from './calendar/logical-day.js';

export class HealthError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'HealthError';
  }
}

export type HealthIntakeRow = {
  id: string;
  user_id: string;
  hydration: number;
  protein: number;
  sodium: number;
  carbohydrate: number;
  calories: number;
  record_date: string;
  quick_add_key: string | null;
  source_image_uri: string | null;
  intake_display_title: string | null;
  intake_ai_comment: string | null;
  created_at: string;
  updated_at: string;
  sync_status: string;
};

export type HealthDailyTargetRow = {
  id: string;
  user_id: string;
  day_ymd: string;
  target_hydration: number;
  target_protein: number;
  target_sodium: number;
  target_carbohydrate: number;
  target_calories: number;
  rationale_zh: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  sync_status: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseNonNegNumber(value: unknown, field: string, fallback = 0): number {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new HealthError(`${field} 必须是非负数字`);
  }
  return n;
}

function requireDayYmd(raw: unknown, fieldName = 'date'): string {
  const text = asTrimmedString(raw);
  if (!text) throw new HealthError(`请传 ${fieldName}（YYYY-MM-DD）`);
  if (!parseYmd(text)) throw new HealthError(`${fieldName} 格式须为 YYYY-MM-DD`);
  return text;
}

function nowShanghaiMysql(): string {
  return formatMySQLWallClockDateTime(new Date());
}

function formatIntake(row: HealthIntakeRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      user_id: row.user_id,
      hydration: Number(row.hydration ?? 0),
      protein: Number(row.protein ?? 0),
      sodium: Number(row.sodium ?? 0),
      carbohydrate: Number(row.carbohydrate ?? 0),
      calories: Number(row.calories ?? 0),
      record_date: row.record_date,
      quick_add_key: row.quick_add_key,
      source_image_uri: row.source_image_uri,
      intake_display_title: row.intake_display_title,
      intake_ai_comment: row.intake_ai_comment,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
    },
    'health_records',
  );
}

function formatTarget(row: HealthDailyTargetRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    day_ymd: row.day_ymd,
    target_hydration: Number(row.target_hydration ?? 0),
    target_protein: Number(row.target_protein ?? 0),
    target_sodium: Number(row.target_sodium ?? 0),
    target_carbohydrate: Number(row.target_carbohydrate ?? 0),
    target_calories: Number(row.target_calories ?? 0),
    rationale_zh: row.rationale_zh,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    sync_status: row.sync_status,
  };
}

/** 显式 user_id；否则取 users 表第一条未删除用户 */
export async function resolveHealthUserId(explicit?: unknown): Promise<string> {
  const fromClient = asTrimmedString(explicit);
  if (fromClient) return fromClient;

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM users
     WHERE deleted_at IS NULL OR deleted_at = ''
     ORDER BY created_at ASC
     LIMIT 1`,
  );
  const id = asTrimmedString(rows[0]?.id);
  if (!id) {
    throw new HealthError('未找到用户，请在请求中传 user_id', 400);
  }
  return id;
}

async function getDailyTarget(
  userId: string,
  dayYmd: string,
): Promise<HealthDailyTargetRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, day_ymd,
            target_hydration, target_protein, target_sodium, target_carbohydrate, target_calories,
            rationale_zh, source, created_at, updated_at, sync_status
     FROM health_daily_targets
     WHERE user_id = ? AND day_ymd = ?
     LIMIT 1`,
    [userId, dayYmd],
  );
  return (rows[0] as HealthDailyTargetRow | undefined) ?? null;
}

/**
 * 某日健康指标：当日摄入合计 + 日目标（若有）。
 * 指标含水分、蛋白质、热量、碳水（并附带钠）。
 */
export async function getDayHealthMetrics(params: {
  date: unknown;
  user_id?: unknown;
}) {
  const dayYmd = requireDayYmd(params.date);
  const userId = await resolveHealthUserId(params.user_id);

  const [sumRows] = await db.query<RowDataPacket[]>(
    `SELECT
        COALESCE(SUM(hydration), 0) AS hydration,
        COALESCE(SUM(protein), 0) AS protein,
        COALESCE(SUM(sodium), 0) AS sodium,
        COALESCE(SUM(carbohydrate), 0) AS carbohydrate,
        COALESCE(SUM(calories), 0) AS calories,
        COUNT(*) AS intake_count
     FROM health_records
     WHERE user_id = ?
       AND LEFT(record_date, 10) = ?`,
    [userId, dayYmd],
  );
  const sum = sumRows[0] ?? {};
  const target = await getDailyTarget(userId, dayYmd);

  const intake = {
    hydration: Number(sum.hydration ?? 0),
    protein: Number(sum.protein ?? 0),
    sodium: Number(sum.sodium ?? 0),
    carbohydrate: Number(sum.carbohydrate ?? 0),
    calories: Number(sum.calories ?? 0),
  };

  return {
    day_ymd: dayYmd,
    user_id: userId,
    intake_count: Number(sum.intake_count ?? 0),
    intake,
    targets: target
      ? {
          target_hydration: Number(target.target_hydration ?? 0),
          target_protein: Number(target.target_protein ?? 0),
          target_sodium: Number(target.target_sodium ?? 0),
          target_carbohydrate: Number(target.target_carbohydrate ?? 0),
          target_calories: Number(target.target_calories ?? 0),
          source: target.source,
          rationale_zh: target.rationale_zh,
        }
      : null,
    /** 便于 APP 直接渲染进度条 */
    progress: {
      hydration: {
        current: intake.hydration,
        target: target ? Number(target.target_hydration ?? 0) : null,
      },
      protein: {
        current: intake.protein,
        target: target ? Number(target.target_protein ?? 0) : null,
      },
      carbohydrate: {
        current: intake.carbohydrate,
        target: target ? Number(target.target_carbohydrate ?? 0) : null,
      },
      calories: {
        current: intake.calories,
        target: target ? Number(target.target_calories ?? 0) : null,
      },
    },
  };
}

/** 某日摄入明细列表（按 record_date 升序） */
export async function listIntakesByDay(params: {
  date: unknown;
  user_id?: unknown;
}) {
  const dayYmd = requireDayYmd(params.date);
  const userId = await resolveHealthUserId(params.user_id);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, hydration, protein, sodium, carbohydrate, calories,
            record_date, quick_add_key, source_image_uri, intake_display_title, intake_ai_comment,
            created_at, updated_at, sync_status
     FROM health_records
     WHERE user_id = ?
       AND LEFT(record_date, 10) = ?
     ORDER BY record_date ASC, created_at ASC`,
    [userId, dayYmd],
  );

  const items = (rows as HealthIntakeRow[]).map(formatIntake);
  return {
    day_ymd: dayYmd,
    user_id: userId,
    items,
    total: items.length,
  };
}

/** 近 N 天摄入记录（含今天，按上海日历日） */
export async function listRecentIntakes(params: {
  days: number;
  user_id?: unknown;
}) {
  const days = Math.trunc(params.days);
  if (![7, 30].includes(days)) {
    throw new HealthError('days 仅支持 7 或 30');
  }

  const userId = await resolveHealthUserId(params.user_id);
  const endYmd = formatLocalYmdFromDate(new Date());
  const startYmd = addDaysToYmd(endYmd, -(days - 1));

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, hydration, protein, sodium, carbohydrate, calories,
            record_date, quick_add_key, source_image_uri, intake_display_title, intake_ai_comment,
            created_at, updated_at, sync_status
     FROM health_records
     WHERE user_id = ?
       AND LEFT(record_date, 10) >= ?
       AND LEFT(record_date, 10) <= ?
     ORDER BY record_date DESC, created_at DESC`,
    [userId, startYmd, endYmd],
  );

  const items = (rows as HealthIntakeRow[]).map(formatIntake);
  return {
    user_id: userId,
    days,
    start_ymd: startYmd,
    end_ymd: endYmd,
    items,
    total: items.length,
  };
}

export type CreateIntakeInput = {
  id?: unknown;
  user_id?: unknown;
  hydration?: unknown;
  protein?: unknown;
  sodium?: unknown;
  carbohydrate?: unknown;
  calories?: unknown;
  record_date?: unknown;
  quick_add_key?: unknown;
  source_image_uri?: unknown;
  intake_display_title?: unknown;
  intake_ai_comment?: unknown;
};

/** 新增一条摄入记录 */
export async function createIntake(input: CreateIntakeInput) {
  const userId = await resolveHealthUserId(input.user_id);
  const id = asTrimmedString(input.id) || randomUUID();

  const hydration = parseNonNegNumber(input.hydration, 'hydration');
  const protein = parseNonNegNumber(input.protein, 'protein');
  const sodium = parseNonNegNumber(input.sodium, 'sodium');
  const carbohydrate = parseNonNegNumber(input.carbohydrate, 'carbohydrate');
  const calories = parseNonNegNumber(input.calories, 'calories');

  let recordDate = asTrimmedString(input.record_date);
  if (!recordDate) {
    recordDate = nowShanghaiMysql();
  } else if (parseYmd(recordDate)) {
    // 纯日期：补当天墙钟 12:00:00，便于排序与展示
    recordDate = `${recordDate} 12:00:00`;
  } else {
    const normalized = normalizeDbDateTimeForTableStorage('health_records', recordDate);
    if (!normalized) throw new HealthError('record_date 格式无效');
    recordDate = normalized;
  }

  const quickAddKey = asTrimmedString(input.quick_add_key) || null;
  const sourceImageUri = asTrimmedString(input.source_image_uri) || null;
  const title = asTrimmedString(input.intake_display_title) || null;
  const aiComment = asTrimmedString(input.intake_ai_comment) || null;

  const now = nowShanghaiMysql();

  try {
    await db.query<ResultSetHeader>(
      `INSERT INTO health_records (
         id, user_id, hydration, protein, sodium, carbohydrate, calories,
         record_date, quick_add_key, source_image_uri, intake_display_title, intake_ai_comment,
         created_at, updated_at, sync_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
      [
        id,
        userId,
        hydration,
        protein,
        sodium,
        carbohydrate,
        calories,
        recordDate,
        quickAddKey,
        sourceImageUri,
        title,
        aiComment,
        now,
        now,
      ],
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new HealthError('记录已存在（id 冲突）', 409);
    }
    throw err;
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, hydration, protein, sodium, carbohydrate, calories,
            record_date, quick_add_key, source_image_uri, intake_display_title, intake_ai_comment,
            created_at, updated_at, sync_status
     FROM health_records WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0] as HealthIntakeRow | undefined;
  if (!row) throw new HealthError('创建失败', 500);
  return formatIntake(row);
}

/** 可选：读取某日目标（供文档/扩展，当前路由未单独暴露也可内部复用） */
export async function getDayTargets(params: { date: unknown; user_id?: unknown }) {
  const dayYmd = requireDayYmd(params.date);
  const userId = await resolveHealthUserId(params.user_id);
  const target = await getDailyTarget(userId, dayYmd);
  return {
    day_ymd: dayYmd,
    user_id: userId,
    targets: target ? formatTarget(target) : null,
  };
}
