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
import {
  appendChangeLog,
  withSyncTransaction,
  type SyncWriteOptions,
} from './sync-change-log.js';
import { deleteLiveWithRevision, stampLiveUpsert, throwTombstoneConflict } from './sync-revision.js';

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

async function getDailyTarget(dayYmd: string): Promise<HealthDailyTargetRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, day_ymd,
            target_hydration, target_protein, target_sodium, target_carbohydrate, target_calories,
            rationale_zh, source, created_at, updated_at, sync_status
     FROM health_daily_targets
     WHERE day_ymd = ?
     LIMIT 1`,
    [dayYmd],
  );
  return (rows[0] as HealthDailyTargetRow | undefined) ?? null;
}

/** 与 App `AppSettingKey.globalIntakeTargets` / `global-intake-targets.ts` 对齐 */
const GLOBAL_INTAKE_TARGETS_KEY = '@global_intake_targets_v1';

const DEFAULT_INTAKE_TARGETS = {
  hydrationMl: 2500,
  proteinG: 80,
  carbohydrateG: 260,
  caloriesKcal: 2000,
} as const;

type ResolvedIntakeTargets = {
  target_hydration: number;
  target_protein: number;
  target_sodium: number;
  target_carbohydrate: number;
  target_calories: number;
  source: string;
  rationale_zh: string | null;
};

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

function coerceTargetNum(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return fallback;
}

async function readGlobalIntakeTargetsSetting(): Promise<{
  hydrationMl: number;
  proteinG: number;
  carbohydrateG: number;
  caloriesKcal: number;
} | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT value_json FROM app_settings WHERE `key` = ? LIMIT 1',
    [GLOBAL_INTAKE_TARGETS_KEY],
  );
  const parsed = parseJsonValue(rows[0]?.value_json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  return {
    hydrationMl: coerceTargetNum(o.hydrationMl, DEFAULT_INTAKE_TARGETS.hydrationMl),
    proteinG: coerceTargetNum(o.proteinG, DEFAULT_INTAKE_TARGETS.proteinG),
    carbohydrateG: coerceTargetNum(o.carbohydrateG, DEFAULT_INTAKE_TARGETS.carbohydrateG),
    caloriesKcal: coerceTargetNum(
      o.caloriesKcal !== undefined ? o.caloriesKcal : o.sodiumMg,
      DEFAULT_INTAKE_TARGETS.caloriesKcal,
    ),
  };
}

async function writeGlobalIntakeTargetsSetting(value: {
  hydrationMl: number;
  proteinG: number;
  carbohydrateG: number;
  caloriesKcal: number;
}): Promise<void> {
  const payload = JSON.stringify(value);
  const now = nowShanghaiMysql();
  await db.query<ResultSetHeader>(
    `INSERT INTO app_settings (\`key\`, value_json, updated_at, sync_status)
     VALUES (?, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE
       value_json = VALUES(value_json),
       updated_at = VALUES(updated_at),
       sync_status = 'synced'`,
    [GLOBAL_INTAKE_TARGETS_KEY, payload, now],
  );
}

/**
 * 日目标优先；否则回退 App 全局键 `@global_intake_targets_v1`；再否则默认值。
 * 保证 Agent snapshot / metrics 的 gaps 始终可算。
 */
async function resolveTargetsForDay(dayYmd: string): Promise<ResolvedIntakeTargets> {
  const day = await getDailyTarget(dayYmd);
  if (day) {
    return {
      target_hydration: Number(day.target_hydration ?? 0),
      target_protein: Number(day.target_protein ?? 0),
      target_sodium: Number(day.target_sodium ?? 0),
      target_carbohydrate: Number(day.target_carbohydrate ?? 0),
      target_calories: Number(day.target_calories ?? 0),
      source: day.source || 'manual',
      rationale_zh: day.rationale_zh,
    };
  }

  const global = await readGlobalIntakeTargetsSetting();
  if (global) {
    return {
      target_hydration: global.hydrationMl,
      target_protein: global.proteinG,
      target_sodium: 0,
      target_carbohydrate: global.carbohydrateG,
      target_calories: global.caloriesKcal,
      source: 'global_settings',
      rationale_zh: null,
    };
  }

  return {
    target_hydration: DEFAULT_INTAKE_TARGETS.hydrationMl,
    target_protein: DEFAULT_INTAKE_TARGETS.proteinG,
    target_sodium: 0,
    target_carbohydrate: DEFAULT_INTAKE_TARGETS.carbohydrateG,
    target_calories: DEFAULT_INTAKE_TARGETS.caloriesKcal,
    source: 'default',
    rationale_zh: null,
  };
}

function dayTargetId(dayYmd: string): string {
  return `hdt_${dayYmd.replace(/-/g, '')}`;
}

/**
 * 某日健康指标：当日摄入合计 + 日目标（日表 → 全局设置 → 默认）。
 * 指标含水分、蛋白质、热量、碳水（并附带钠）。
 */
export async function getDayHealthMetrics(params: { date: unknown }) {
  const dayYmd = requireDayYmd(params.date);

  const [sumRows] = await db.query<RowDataPacket[]>(
    `SELECT
        COALESCE(SUM(hydration), 0) AS hydration,
        COALESCE(SUM(protein), 0) AS protein,
        COALESCE(SUM(sodium), 0) AS sodium,
        COALESCE(SUM(carbohydrate), 0) AS carbohydrate,
        COALESCE(SUM(calories), 0) AS calories,
        COUNT(*) AS intake_count
     FROM health_records
     WHERE LEFT(record_date, 10) = ?`,
    [dayYmd],
  );
  const sum = sumRows[0] ?? {};
  const target = await resolveTargetsForDay(dayYmd);

  const intake = {
    hydration: Number(sum.hydration ?? 0),
    protein: Number(sum.protein ?? 0),
    sodium: Number(sum.sodium ?? 0),
    carbohydrate: Number(sum.carbohydrate ?? 0),
    calories: Number(sum.calories ?? 0),
  };

  return {
    day_ymd: dayYmd,
    intake_count: Number(sum.intake_count ?? 0),
    intake,
    targets: {
      target_hydration: target.target_hydration,
      target_protein: target.target_protein,
      target_sodium: target.target_sodium,
      target_carbohydrate: target.target_carbohydrate,
      target_calories: target.target_calories,
      source: target.source,
      rationale_zh: target.rationale_zh,
    },
    /** 便于 APP 直接渲染进度条 */
    progress: {
      hydration: {
        current: intake.hydration,
        target: target.target_hydration,
      },
      protein: {
        current: intake.protein,
        target: target.target_protein,
      },
      carbohydrate: {
        current: intake.carbohydrate,
        target: target.target_carbohydrate,
      },
      calories: {
        current: intake.calories,
        target: target.target_calories,
      },
    },
  };
}

/** 某日摄入明细列表（按 record_date 升序） */
export async function listIntakesByDay(params: { date: unknown }) {
  const dayYmd = requireDayYmd(params.date);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, hydration, protein, sodium, carbohydrate, calories,
            record_date, quick_add_key, source_image_uri, intake_display_title, intake_ai_comment,
            created_at, updated_at, sync_status
     FROM health_records
     WHERE LEFT(record_date, 10) = ?
     ORDER BY record_date ASC, created_at ASC`,
    [dayYmd],
  );

  const items = (rows as HealthIntakeRow[]).map(formatIntake);
  return {
    day_ymd: dayYmd,
    items,
    total: items.length,
  };
}

/** 近 N 天摄入记录（含今天，按上海日历日） */
export async function listRecentIntakes(params: { days: number }) {
  const days = Math.trunc(params.days);
  if (![7, 30].includes(days)) {
    throw new HealthError('days 仅支持 7 或 30');
  }

  const endYmd = formatLocalYmdFromDate(new Date());
  const startYmd = addDaysToYmd(endYmd, -(days - 1));

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, hydration, protein, sodium, carbohydrate, calories,
            record_date, quick_add_key, source_image_uri, intake_display_title, intake_ai_comment,
            created_at, updated_at, sync_status
     FROM health_records
     WHERE LEFT(record_date, 10) >= ?
       AND LEFT(record_date, 10) <= ?
     ORDER BY record_date DESC, created_at DESC`,
    [startYmd, endYmd],
  );

  const items = (rows as HealthIntakeRow[]).map(formatIntake);
  return {
    days,
    start_ymd: startYmd,
    end_ymd: endYmd,
    items,
    total: items.length,
  };
}

export type CreateIntakeInput = {
  id?: unknown;
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
export async function createIntake(input: CreateIntakeInput, options?: SyncWriteOptions) {
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
    await withSyncTransaction(async (conn) => {
      await conn.query<ResultSetHeader>(
        `INSERT INTO health_records (
           id, hydration, protein, sodium, carbohydrate, calories,
           record_date, quick_add_key, source_image_uri, intake_display_title, intake_ai_comment,
           created_at, updated_at, sync_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
        [
          id,
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
      const stamp = await stampLiveUpsert(conn, 'health_records', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'health_records',
          recordPk: id,
          op: 'upsert',
          updatedAt: now,
          deviceId: options?.deviceId,
          serverRev: stamp.serverRev,
          mutationId: stamp.mutationId,
        },
      ]);
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new HealthError('记录已存在（id 冲突）', 409);
    }
    throw err;
  }

  return getIntake(id);
}

const INTAKE_SELECT = `SELECT id, hydration, protein, sodium, carbohydrate, calories,
            record_date, quick_add_key, source_image_uri, intake_display_title, intake_ai_comment,
            created_at, updated_at, sync_status
     FROM health_records`;

export async function getIntake(id: string) {
  const trimmed = asTrimmedString(id);
  if (!trimmed) throw new HealthError('缺少记录 id');
  const [rows] = await db.query<RowDataPacket[]>(`${INTAKE_SELECT} WHERE id = ? LIMIT 1`, [
    trimmed,
  ]);
  const row = rows[0] as HealthIntakeRow | undefined;
  if (!row) return null;
  return formatIntake(row);
}

export type UpdateIntakeInput = CreateIntakeInput;

/** 更新一条摄入记录（仅更新传入字段） */
export async function updateIntake(
  id: string,
  input: UpdateIntakeInput,
  options?: SyncWriteOptions,
) {
  const trimmed = asTrimmedString(id);
  if (!trimmed) throw new HealthError('缺少记录 id');

  const existing = await getIntake(trimmed);
  if (!existing) {
    throw await throwTombstoneConflict(db, 'health_records', trimmed);
  }

  const has = (key: keyof UpdateIntakeInput) => Object.prototype.hasOwnProperty.call(input, key);

  const hydration = has('hydration')
    ? parseNonNegNumber(input.hydration, 'hydration')
    : Number(existing.hydration ?? 0);
  const protein = has('protein')
    ? parseNonNegNumber(input.protein, 'protein')
    : Number(existing.protein ?? 0);
  const sodium = has('sodium')
    ? parseNonNegNumber(input.sodium, 'sodium')
    : Number(existing.sodium ?? 0);
  const carbohydrate = has('carbohydrate')
    ? parseNonNegNumber(input.carbohydrate, 'carbohydrate')
    : Number(existing.carbohydrate ?? 0);
  const calories = has('calories')
    ? parseNonNegNumber(input.calories, 'calories')
    : Number(existing.calories ?? 0);

  let recordDate = String(existing.record_date ?? '');
  if (has('record_date')) {
    const raw = asTrimmedString(input.record_date);
    if (!raw) throw new HealthError('record_date 不能为空');
    if (parseYmd(raw)) {
      recordDate = `${raw} 12:00:00`;
    } else {
      const normalized = normalizeDbDateTimeForTableStorage('health_records', raw);
      if (!normalized) throw new HealthError('record_date 格式无效');
      recordDate = normalized;
    }
  }

  const quickAddKey = has('quick_add_key')
    ? asTrimmedString(input.quick_add_key) || null
    : (existing.quick_add_key as string | null);
  const sourceImageUri = has('source_image_uri')
    ? asTrimmedString(input.source_image_uri) || null
    : (existing.source_image_uri as string | null);
  const title = has('intake_display_title')
    ? asTrimmedString(input.intake_display_title) || null
    : (existing.intake_display_title as string | null);
  const aiComment = has('intake_ai_comment')
    ? asTrimmedString(input.intake_ai_comment) || null
    : (existing.intake_ai_comment as string | null);

  const now = nowShanghaiMysql();
  await withSyncTransaction(async (conn) => {
    await conn.query<ResultSetHeader>(
      `UPDATE health_records SET
         hydration = ?, protein = ?, sodium = ?, carbohydrate = ?, calories = ?,
         record_date = ?, quick_add_key = ?, source_image_uri = ?,
         intake_display_title = ?, intake_ai_comment = ?,
         updated_at = ?, sync_status = 'synced'
       WHERE id = ?`,
      [
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
        trimmed,
      ],
    );
    const stamp = await stampLiveUpsert(conn, 'health_records', trimmed, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'health_records',
        recordPk: trimmed,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });

  const updated = await getIntake(trimmed);
  if (!updated) throw new HealthError('更新失败', 500);
  return updated;
}

/** 删除一条摄入记录 */
export async function deleteIntake(id: string, options?: SyncWriteOptions) {
  const trimmed = asTrimmedString(id);
  if (!trimmed) throw new HealthError('缺少记录 id');

  await withSyncTransaction(async (conn) => {
    const del = await deleteLiveWithRevision(conn, 'health_records', trimmed, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (del.kind === 'already_gone') {
      return;
    }
    await appendChangeLog(conn, [
      {
        tableName: 'health_records',
        recordPk: trimmed,
        op: 'delete',
        deviceId: options?.deviceId,
        serverRev: del.serverRev,
        mutationId: del.mutationId,
      },
    ]);
  });
  return { deleted: true as const, id: trimmed };
}

/** 读取某日目标（日表 → 全局设置 → 默认）；缺省 date 为今日 */
export async function getDayTargets(params: { date?: unknown } = {}) {
  const dayYmd =
    params.date != null && asTrimmedString(params.date)
      ? requireDayYmd(params.date)
      : formatLocalYmdFromDate(new Date());
  const resolved = await resolveTargetsForDay(dayYmd);
  const dayRow = await getDailyTarget(dayYmd);
  const global = await readGlobalIntakeTargetsSetting();
  return {
    day_ymd: dayYmd,
    targets: {
      target_hydration: resolved.target_hydration,
      target_protein: resolved.target_protein,
      target_sodium: resolved.target_sodium,
      target_carbohydrate: resolved.target_carbohydrate,
      target_calories: resolved.target_calories,
      source: resolved.source,
      rationale_zh: resolved.rationale_zh,
    },
    day_row: dayRow ? formatTarget(dayRow) : null,
    global: global ?? {
      hydrationMl: DEFAULT_INTAKE_TARGETS.hydrationMl,
      proteinG: DEFAULT_INTAKE_TARGETS.proteinG,
      carbohydrateG: DEFAULT_INTAKE_TARGETS.carbohydrateG,
      caloriesKcal: DEFAULT_INTAKE_TARGETS.caloriesKcal,
    },
  };
}

export type UpsertIntakeTargetsInput = {
  date?: unknown;
  hydration?: unknown;
  hydration_ml?: unknown;
  hydrationMl?: unknown;
  protein?: unknown;
  protein_g?: unknown;
  proteinG?: unknown;
  carbohydrate?: unknown;
  carbohydrate_g?: unknown;
  carbohydrateG?: unknown;
  calories?: unknown;
  calories_kcal?: unknown;
  caloriesKcal?: unknown;
  rationale_zh?: unknown;
  source?: unknown;
};

/**
 * 写入全局四项目标（app_settings）并 upsert 指定日（默认今日）的 health_daily_targets。
 * 对齐 App `commit_intake_targets` / Agent snapshot。
 */
export async function upsertIntakeTargets(
  input: UpsertIntakeTargetsInput,
  options?: SyncWriteOptions,
) {
  const dayYmd = input.date != null && asTrimmedString(input.date)
    ? requireDayYmd(input.date)
    : formatLocalYmdFromDate(new Date());

  const current =
    (await readGlobalIntakeTargetsSetting()) ?? {
      hydrationMl: DEFAULT_INTAKE_TARGETS.hydrationMl,
      proteinG: DEFAULT_INTAKE_TARGETS.proteinG,
      carbohydrateG: DEFAULT_INTAKE_TARGETS.carbohydrateG,
      caloriesKcal: DEFAULT_INTAKE_TARGETS.caloriesKcal,
    };

  const pick = (...keys: unknown[]): number | null => {
    for (const k of keys) {
      if (k == null || k === '') continue;
      return parseNonNegNumber(k, 'target');
    }
    return null;
  };

  const hydration =
    pick(input.hydration_ml, input.hydrationMl, input.hydration) ?? current.hydrationMl;
  const protein = pick(input.protein_g, input.proteinG, input.protein) ?? current.proteinG;
  const carbohydrate =
    pick(input.carbohydrate_g, input.carbohydrateG, input.carbohydrate) ??
    current.carbohydrateG;
  const calories =
    pick(input.calories_kcal, input.caloriesKcal, input.calories) ?? current.caloriesKcal;

  const sourceRaw = asTrimmedString(input.source) || 'manual';
  const source = sourceRaw.slice(0, 32);
  const rationale =
    input.rationale_zh == null || input.rationale_zh === ''
      ? null
      : asTrimmedString(input.rationale_zh) || null;

  const globalPayload = {
    hydrationMl: hydration,
    proteinG: protein,
    carbohydrateG: carbohydrate,
    caloriesKcal: calories,
  };
  await writeGlobalIntakeTargetsSetting(globalPayload);

  const now = nowShanghaiMysql();
  const id = dayTargetId(dayYmd);

  await withSyncTransaction(async (conn) => {
    const [existing] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM health_daily_targets WHERE day_ymd = ? LIMIT 1`,
      [dayYmd],
    );
    const prev = existing[0];
    const rowId = prev ? String(prev.id) : id;

    if (prev) {
      await conn.query<ResultSetHeader>(
        `UPDATE health_daily_targets
         SET target_hydration = ?, target_protein = ?, target_sodium = 0,
             target_carbohydrate = ?, target_calories = ?,
             rationale_zh = ?, source = ?, updated_at = ?, sync_status = 'synced'
         WHERE day_ymd = ?`,
        [hydration, protein, carbohydrate, calories, rationale, source, now, dayYmd],
      );
      const stamp = await stampLiveUpsert(conn, 'health_daily_targets', rowId, {
        mode: 'update',
        mutationId: options?.mutationId,
        skipOcc: true,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'health_daily_targets',
          recordPk: rowId,
          op: 'upsert',
          updatedAt: now,
          deviceId: options?.deviceId,
          serverRev: stamp.serverRev,
          mutationId: stamp.mutationId,
        },
      ]);
    } else {
      await conn.query<ResultSetHeader>(
        `INSERT INTO health_daily_targets (
           id, day_ymd, target_hydration, target_protein, target_sodium,
           target_carbohydrate, target_calories, rationale_zh, source,
           created_at, updated_at, sync_status
         ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'synced')`,
        [
          rowId,
          dayYmd,
          hydration,
          protein,
          carbohydrate,
          calories,
          rationale,
          source,
          now,
          now,
        ],
      );
      const stamp = await stampLiveUpsert(conn, 'health_daily_targets', rowId, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'health_daily_targets',
          recordPk: rowId,
          op: 'upsert',
          updatedAt: now,
          deviceId: options?.deviceId,
          serverRev: stamp.serverRev,
          mutationId: stamp.mutationId,
        },
      ]);
    }
  });

  return {
    day_ymd: dayYmd,
    global: globalPayload,
    targets: {
      target_hydration: hydration,
      target_protein: protein,
      target_sodium: 0,
      target_carbohydrate: carbohydrate,
      target_calories: calories,
      source,
      rationale_zh: rationale,
    },
  };
}
