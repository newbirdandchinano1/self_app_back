/**
 * 我的页偏好：饮食偏好（app_settings）+ 健身日（users.workout_days / rest_days）。
 * 挂载：/api/app/pages/profile/*
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { formatUtcMySQLDateTime } from './calendar/logical-day.js';

export class ProfilePrefsError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ProfilePrefsError';
  }
}

export const DIETARY_PREFS_KEY = '@selfapp/dietary_prefs_v1';

export const DIETARY_PRESET_TAGS = [
  '素食',
  '蛋奶素',
  '不喝奶',
  '无麸质',
  '低糖',
  '低脂',
  '清真',
  '不吃猪肉',
  '不吃海鲜',
  '不吃辣',
] as const;

export const WEEK_DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

export type DietaryPrefs = {
  tags: string[];
  allergies: string;
  avoidFoods: string;
  notes: string;
};

const DEFAULT_DIETARY: DietaryPrefs = {
  tags: [],
  allergies: '',
  avoidFoods: '',
  notes: '',
};

function clampText(raw: unknown, max = 200): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, max);
}

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

export function normalizeDietaryPrefs(raw: unknown): DietaryPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_DIETARY };
  }
  const o = raw as Record<string, unknown>;
  const presetSet = new Set<string>(DIETARY_PRESET_TAGS);
  const tags = Array.isArray(o.tags)
    ? o.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && presetSet.has(t))
    : [];
  return {
    tags: [...new Set(tags)],
    allergies: clampText(o.allergies),
    avoidFoods: clampText(o.avoidFoods),
    notes: clampText(o.notes, 300),
  };
}

export function isDietaryPrefsEmpty(prefs: DietaryPrefs): boolean {
  return (
    prefs.tags.length === 0 &&
    !prefs.allergies.trim() &&
    !prefs.avoidFoods.trim() &&
    !prefs.notes.trim()
  );
}

export function formatDietaryPrefsSummary(prefs: DietaryPrefs): string {
  if (isDietaryPrefsEmpty(prefs)) return '未设置';
  const parts: string[] = [];
  if (prefs.tags.length) parts.push(prefs.tags.slice(0, 3).join('、'));
  if (prefs.allergies.trim()) parts.push(`过敏：${prefs.allergies.trim()}`);
  if (prefs.avoidFoods.trim()) parts.push(`忌口：${prefs.avoidFoods.trim()}`);
  return parts.join(' · ') || '已设置';
}

async function readSetting(key: string): Promise<unknown> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT value_json FROM app_settings WHERE `key` = ? LIMIT 1',
    [key],
  );
  return parseJsonValue(rows[0]?.value_json);
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value);
  const now = formatUtcMySQLDateTime(new Date());
  await db.query<ResultSetHeader>(
    `INSERT INTO app_settings (\`key\`, value_json, updated_at, sync_status)
     VALUES (?, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE
       value_json = VALUES(value_json),
       updated_at = VALUES(updated_at),
       sync_status = 'synced'`,
    [key, payload, now],
  );
}

export async function getDietaryPrefs(): Promise<{
  prefs: DietaryPrefs;
  empty: boolean;
  summary: string;
}> {
  const prefs = normalizeDietaryPrefs(await readSetting(DIETARY_PREFS_KEY));
  return {
    prefs,
    empty: isDietaryPrefsEmpty(prefs),
    summary: formatDietaryPrefsSummary(prefs),
  };
}

export async function putDietaryPrefs(input: unknown) {
  const prefs = normalizeDietaryPrefs(input);
  await writeSetting(DIETARY_PREFS_KEY, prefs);
  return {
    prefs,
    empty: isDietaryPrefsEmpty(prefs),
    summary: formatDietaryPrefsSummary(prefs),
  };
}

function isFitnessLifestyle(lifestyle?: string | null): boolean {
  return lifestyle === '健身' || lifestyle === '高强度锻炼';
}

function normalizeWorkoutDays(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return WEEK_DAYS.filter((d) => raw.includes(d));
}

function deriveRestDays(workoutDays: string[]): string[] {
  const set = new Set(workoutDays);
  return WEEK_DAYS.filter((d) => !set.has(d));
}

async function loadPrimaryUser(): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, gender, lifestyle, goal, birthday, height, weight, age,
            persona_portrait, avatar_uri, workout_days, rest_days
     FROM users
     WHERE (deleted_at IS NULL OR deleted_at = '')
       AND (sync_status IS NULL OR sync_status != 'pending_delete')
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * 设置健身日；非健身习惯时强制清空。
 * 可顺带传 lifestyle 以便一次改完。
 */
export async function updateWorkoutDays(input: {
  workout_days?: unknown;
  lifestyle?: unknown;
}) {
  const user = await loadPrimaryUser();
  if (!user) throw new ProfilePrefsError('无用户资料', 404);

  const lifestyleRaw =
    input.lifestyle != null && String(input.lifestyle).trim()
      ? String(input.lifestyle).trim()
      : String(user.lifestyle ?? '');
  const fitness = isFitnessLifestyle(lifestyleRaw);
  const days = fitness ? normalizeWorkoutDays(input.workout_days) : [];
  const rest = deriveRestDays(days);
  const now = formatUtcMySQLDateTime(new Date());

  await db.query<ResultSetHeader>(
    `UPDATE users
     SET lifestyle = ?, workout_days = ?, rest_days = ?, updated_at = ?
     WHERE id = ?`,
    [
      lifestyleRaw || user.lifestyle || '长期静坐不运动',
      JSON.stringify(days),
      JSON.stringify(rest),
      now,
      String(user.id),
    ],
  );

  return {
    lifestyle: lifestyleRaw || String(user.lifestyle ?? ''),
    workout_days: days,
    rest_days: rest,
    cleared: !fitness,
  };
}
