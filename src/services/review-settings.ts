/**
 * 复盘设置语义 API：每周复盘日 / 日·周提醒 / 积分规则。
 * 键与 App `AppSettingKey` 对齐；相对裸 app_settings CRUD 供 Agent 读写。
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { formatUtcMySQLDateTime } from './calendar/logical-day.js';
import { ReviewPageError } from './pages/review.js';

export { ReviewPageError as ReviewSettingsError };

const KEYS = {
  weeklyReviewWeekday: 'weekly_review_weekday_dow',
  dailyReminderEnabled: 'daily_review_reminder_enabled_v1',
  dailyReminderHour: 'daily_review_reminder_hour_v1',
  dailyReminderMinute: 'daily_review_reminder_minute_v1',
  weeklyReminderEnabled: 'weekly_review_reminder_enabled_v1',
  weeklyReminderHour: 'weekly_review_reminder_hour_v1',
  weeklyReminderMinute: 'weekly_review_reminder_minute_v1',
  reviewPoints: '@review_points_v1',
} as const;

const DEFAULT_DAILY_HOUR = 21;
const DEFAULT_DAILY_MINUTE = 0;
const DEFAULT_WEEKLY_HOUR = 20;
const DEFAULT_WEEKLY_MINUTE = 0;

const DEFAULT_POINTS = {
  enabled: false,
  dailyRewardPoints: 5,
  streak7BonusPoints: 30,
} as const;

const POINTS_ABS_MAX = 99999;

export type ReviewReminderSettings = {
  enabled: boolean;
  hour: number;
  minute: number;
};

export type ReviewPointsSettings = {
  enabled: boolean;
  dailyRewardPoints: number;
  streak7BonusPoints: number;
};

export type ReviewSettings = {
  domain: 'review_settings';
  weekly_review_weekday: number | null;
  weekly_review_weekday_label: string | null;
  daily_reminder: ReviewReminderSettings;
  weekly_reminder: ReviewReminderSettings;
  points: ReviewPointsSettings;
  keys: typeof KEYS;
  note: string;
};

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

function parseJsonValue(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function coerceSettingString(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return null;
}

function clampHour(n: number): number {
  return Math.max(0, Math.min(23, Math.floor(n)));
}

function clampMinute(n: number): number {
  return Math.max(0, Math.min(59, Math.floor(n)));
}

function parseClockPart(raw: unknown, fallback: number, clamp: (n: number) => number): number {
  const s = coerceSettingString(raw);
  if (s == null || s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? clamp(n) : fallback;
}

function parseEnabled(raw: unknown): boolean {
  const s = coerceSettingString(raw);
  return s === '1' || s === 'true' || raw === true || raw === 1;
}

function roundPoints(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(typeof raw === 'string' ? raw.trim() : raw);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(n * 100) / 100;
}

function normalizeRewardPoints(raw: unknown): number {
  const n = roundPoints(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(POINTS_ABS_MAX, Math.max(-POINTS_ABS_MAX, n));
}

function normalizePoints(raw: unknown): ReviewPointsSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_POINTS };
  }
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    dailyRewardPoints: normalizeRewardPoints(o.dailyRewardPoints ?? o.daily_reward_points),
    streak7BonusPoints: normalizeRewardPoints(o.streak7BonusPoints ?? o.streak7_bonus_points),
  };
}

async function readSetting(key: string): Promise<unknown> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT value_json FROM app_settings WHERE `key` = ? LIMIT 1',
    [key],
  );
  return parseJsonValue(rows[0]?.value_json);
}

/** 与 App serializeValue 对齐：字符串原样写入，对象 JSON.stringify */
async function writeSetting(key: string, value: unknown): Promise<void> {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
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

async function deleteSetting(key: string): Promise<void> {
  await db.query<ResultSetHeader>('DELETE FROM app_settings WHERE `key` = ?', [key]);
}

function parseWeekday(raw: unknown): number | null {
  const s = coerceSettingString(raw);
  if (s == null || s === '') return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 6) return null;
  return n;
}

async function loadReminder(
  enabledKey: string,
  hourKey: string,
  minuteKey: string,
  defaultHour: number,
  defaultMinute: number,
): Promise<ReviewReminderSettings> {
  const [enabledRaw, hourRaw, minuteRaw] = await Promise.all([
    readSetting(enabledKey),
    readSetting(hourKey),
    readSetting(minuteKey),
  ]);
  return {
    enabled: parseEnabled(enabledRaw),
    hour: parseClockPart(hourRaw, defaultHour, clampHour),
    minute: parseClockPart(minuteRaw, defaultMinute, clampMinute),
  };
}

export async function getReviewSettings(): Promise<ReviewSettings> {
  const [weekdayRaw, daily, weekly, pointsRaw] = await Promise.all([
    readSetting(KEYS.weeklyReviewWeekday),
    loadReminder(
      KEYS.dailyReminderEnabled,
      KEYS.dailyReminderHour,
      KEYS.dailyReminderMinute,
      DEFAULT_DAILY_HOUR,
      DEFAULT_DAILY_MINUTE,
    ),
    loadReminder(
      KEYS.weeklyReminderEnabled,
      KEYS.weeklyReminderHour,
      KEYS.weeklyReminderMinute,
      DEFAULT_WEEKLY_HOUR,
      DEFAULT_WEEKLY_MINUTE,
    ),
    readSetting(KEYS.reviewPoints),
  ]);
  const weekday = parseWeekday(weekdayRaw);
  return {
    domain: 'review_settings',
    weekly_review_weekday: weekday,
    weekly_review_weekday_label: weekday == null ? null : WEEKDAY_LABELS[weekday],
    daily_reminder: daily,
    weekly_reminder: weekly,
    points: normalizePoints(pointsRaw),
    keys: KEYS,
    note: '复盘设置语义读写；通知真正排程仍由客户端本地完成。',
  };
}

export type PutReviewSettingsInput = {
  weekly_review_weekday?: number | null;
  weeklyReviewWeekday?: number | null;
  clear_weekly_review_weekday?: boolean;
  clearWeeklyReviewWeekday?: boolean;
  daily_reminder?: Partial<ReviewReminderSettings> | null;
  dailyReminder?: Partial<ReviewReminderSettings> | null;
  weekly_reminder?: Partial<ReviewReminderSettings> | null;
  weeklyReminder?: Partial<ReviewReminderSettings> | null;
  points?: Partial<ReviewPointsSettings> | null;
};

async function writeReminder(
  enabledKey: string,
  hourKey: string,
  minuteKey: string,
  current: ReviewReminderSettings,
  patch: Partial<ReviewReminderSettings>,
): Promise<void> {
  const next: ReviewReminderSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    hour: patch.hour != null && Number.isFinite(Number(patch.hour))
      ? clampHour(Number(patch.hour))
      : current.hour,
    minute: patch.minute != null && Number.isFinite(Number(patch.minute))
      ? clampMinute(Number(patch.minute))
      : current.minute,
  };
  const writes: Promise<void>[] = [
    writeSetting(hourKey, String(next.hour)),
    writeSetting(minuteKey, String(next.minute)),
  ];
  if (next.enabled) {
    writes.push(writeSetting(enabledKey, '1'));
  } else {
    writes.push(deleteSetting(enabledKey));
  }
  await Promise.all(writes);
}

export async function putReviewSettings(input: PutReviewSettingsInput): Promise<ReviewSettings> {
  const current = await getReviewSettings();
  const clearWeekday = Boolean(
    input.clear_weekly_review_weekday ?? input.clearWeeklyReviewWeekday,
  );
  const weekdayRaw = input.weekly_review_weekday ?? input.weeklyReviewWeekday;
  if (clearWeekday) {
    await deleteSetting(KEYS.weeklyReviewWeekday);
  } else if (weekdayRaw !== undefined) {
    if (weekdayRaw === null) {
      await deleteSetting(KEYS.weeklyReviewWeekday);
    } else {
      const n = Math.round(Number(weekdayRaw));
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        throw new ReviewPageError('weekly_review_weekday 须为 0–6（周日=0）');
      }
      await writeSetting(KEYS.weeklyReviewWeekday, String(n));
    }
  }

  const dailyPatch = input.daily_reminder ?? input.dailyReminder;
  if (dailyPatch && typeof dailyPatch === 'object') {
    await writeReminder(
      KEYS.dailyReminderEnabled,
      KEYS.dailyReminderHour,
      KEYS.dailyReminderMinute,
      current.daily_reminder,
      dailyPatch,
    );
  }

  const weeklyPatch = input.weekly_reminder ?? input.weeklyReminder;
  if (weeklyPatch && typeof weeklyPatch === 'object') {
    await writeReminder(
      KEYS.weeklyReminderEnabled,
      KEYS.weeklyReminderHour,
      KEYS.weeklyReminderMinute,
      current.weekly_reminder,
      weeklyPatch,
    );
  }

  if (input.points && typeof input.points === 'object') {
    const next = normalizePoints({
      ...current.points,
      ...input.points,
      dailyRewardPoints:
        input.points.dailyRewardPoints ??
        (input.points as { daily_reward_points?: number }).daily_reward_points ??
        current.points.dailyRewardPoints,
      streak7BonusPoints:
        input.points.streak7BonusPoints ??
        (input.points as { streak7_bonus_points?: number }).streak7_bonus_points ??
        current.points.streak7BonusPoints,
      enabled:
        typeof input.points.enabled === 'boolean'
          ? input.points.enabled
          : current.points.enabled,
    });
    await writeSetting(KEYS.reviewPoints, next);
  }

  return getReviewSettings();
}
