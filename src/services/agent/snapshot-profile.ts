/**
 * Agent 只读资料快照：完整度、饮食偏好、体重趋势、本周节奏、档案摘要。
 * 挂载：GET /api/app/agent/snapshot/profile
 */
import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import {
  addDaysToYmd,
  formatLocalYmdFromDate,
  startOfWeekMonday,
} from '../calendar/logical-day.js';
import {
  formatDietaryPrefsSummary,
  getDietaryPrefs,
  isDietaryPrefsEmpty,
  type DietaryPrefs,
} from '../profile-prefs.js';
import { listWeightLogs } from '../weight-logs.js';

export class ProfileSnapshotError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ProfileSnapshotError';
  }
}

export type AgentProfileSnapshotParams = {
  logicalToday?: string;
};

const ACTIVE_SQL = `(deleted_at IS NULL OR deleted_at = '') AND (sync_status IS NULL OR sync_status != 'pending_delete')`;

type FillChipKey = 'persona' | 'dietary' | 'birthday' | 'body';

function asNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function trimStr(v: unknown, max = 200): string {
  return String(v ?? '')
    .trim()
    .slice(0, max);
}

function oneLiner(portrait: string, max = 80): string | null {
  const s = portrait.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function calcBmi(heightCm: number, weightKg: number): number | null {
  if (!(heightCm > 0) || !(weightKg > 0)) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

function parseWorkoutDays(raw: unknown): string[] {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try {
      parsed = JSON.parse(t);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
}

function weekRangeFromToday(todayYmd: string): { startYmd: string; endYmd: string } {
  const [y, m, d] = todayYmd.split('-').map(Number);
  // 中午锚点，避免时区边界；startOfWeekMonday 按 App 时区取本周一
  const anchor = new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
  const monday = startOfWeekMonday(anchor);
  const startYmd = formatLocalYmdFromDate(monday);
  const endYmd = addDaysToYmd(startYmd, 6);
  return { startYmd, endYmd };
}

async function loadPrimaryUser(): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, gender, lifestyle, goal, birthday, height, weight, age,
            persona_portrait, avatar_uri, workout_days, rest_days
     FROM users
     WHERE ${ACTIVE_SQL}
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function computeWeekRhythm(todayYmd: string) {
  const { startYmd, endYmd } = weekRangeFromToday(todayYmd);
  const elapsedEnd = todayYmd < endYmd ? todayYmd : endYmd;
  const daysElapsed = Math.max(
    1,
    Math.round(
      (Date.parse(`${elapsedEnd}T12:00:00Z`) - Date.parse(`${startYmd}T12:00:00Z`)) / 86400000,
    ) + 1,
  );

  const lastWeekStart = addDaysToYmd(startYmd, -7);
  const lastWeekEnd = addDaysToYmd(startYmd, -1);

  const [[habitRows], [checkInRows], [taskRows], [dailyRows], [weeklyRows]] = await Promise.all([
    db.query<RowDataPacket[]>(
      `SELECT id FROM habits WHERE sync_status IS NULL OR sync_status != 'pending_delete'`,
    ),
    db.query<RowDataPacket[]>(
      `SELECT habit_id, count, record_date FROM habit_check_ins
       WHERE record_date >= ? AND record_date <= ?
         AND (sync_status IS NULL OR sync_status != 'pending_delete')`,
      [startYmd, elapsedEnd],
    ),
    db.query<RowDataPacket[]>(
      `SELECT status, completed_at FROM tasks
       WHERE sync_status IS NULL OR sync_status != 'pending_delete'`,
    ),
    db.query<RowDataPacket[]>(
      `SELECT record_date_ymd FROM daily_review_journal
       WHERE record_date_ymd >= ? AND record_date_ymd <= ?
         AND (sync_status IS NULL OR sync_status != 'pending_delete')`,
      [startYmd, endYmd],
    ),
    db.query<RowDataPacket[]>(
      `SELECT id FROM weekly_review_journal
       WHERE week_start_ymd = ?
         AND (sync_status IS NULL OR sync_status != 'pending_delete')
       LIMIT 1`,
      [startYmd],
    ),
  ]);

  const activeHabitIds = new Set(habitRows.map((r) => String(r.id)));
  const habitCheckInTotal = checkInRows
    .filter((c) => activeHabitIds.has(String(c.habit_id)) && Number(c.count) > 0)
    .reduce((sum, c) => sum + Math.max(0, Number(c.count) || 0), 0);
  const activeHabitCount = activeHabitIds.size;
  const expectedSlots = Math.max(1, activeHabitCount * daysElapsed);
  const habitRate =
    activeHabitCount === 0
      ? 0
      : Math.min(100, Math.round((habitCheckInTotal / expectedSlots) * 100));

  const countDoneBetween = (start: string, end: string) =>
    taskRows.filter((t) => {
      if (String(t.status) !== 'done' || !t.completed_at) return false;
      const day = String(t.completed_at).slice(0, 10);
      return day >= start && day <= end;
    }).length;

  const tasksCompleted = countDoneBetween(startYmd, elapsedEnd);
  const lastWeekTasks = countDoneBetween(lastWeekStart, lastWeekEnd);

  const reviewDays = new Set(
    dailyRows.map((r) => String(r.record_date_ymd || '').trim()).filter(Boolean),
  );
  const dayStrip = Array.from({ length: 7 }, (_, i) =>
    reviewDays.has(addDaysToYmd(startYmd, i)),
  );
  let todayStripIndex = -1;
  for (let i = 0; i < 7; i++) {
    if (addDaysToYmd(startYmd, i) === todayYmd) {
      todayStripIndex = i;
      break;
    }
  }

  return {
    week_start_ymd: startYmd,
    week_end_ymd: endYmd,
    habit_check_in_total: habitCheckInTotal,
    habit_expected_slots: expectedSlots,
    active_habit_count: activeHabitCount,
    habit_check_in_rate_percent: habitRate,
    tasks_completed: tasksCompleted,
    tasks_delta_vs_last_week: tasksCompleted - lastWeekTasks,
    daily_review_days: reviewDays.size,
    days_elapsed_inclusive: daysElapsed,
    weekly_review_done: weeklyRows.length > 0,
    day_strip: dayStrip,
    today_strip_index: todayStripIndex,
  };
}

export async function getAgentProfileSnapshot(params: AgentProfileSnapshotParams = {}) {
  const todayRaw = String(params.logicalToday || '').trim();
  const today =
    todayRaw && /^\d{4}-\d{2}-\d{2}$/.test(todayRaw)
      ? todayRaw
      : formatLocalYmdFromDate(new Date());

  const [user, dietaryBundle, weightBundle, week] = await Promise.all([
    loadPrimaryUser(),
    getDietaryPrefs().catch(
      (): { prefs: DietaryPrefs; empty: boolean; summary: string } => ({
        prefs: { tags: [], allergies: '', avoidFoods: '', notes: '' },
        empty: true,
        summary: '未设置',
      }),
    ),
    listWeightLogs({ days: 30, end_ymd: today }).catch(() => null),
    computeWeekRhythm(today).catch(() => null),
  ]);

  const dietary = dietaryBundle.prefs;
  const dietaryEmpty = dietaryBundle.empty;
  const dietarySummary = dietaryBundle.summary;

  if (!user) {
    return {
      domain: 'profile',
      today_ymd: today,
      has_user: false,
      completeness_percent: 0,
      filled_count: 0,
      total_count: 5,
      missing_count: 5,
      fill_chips: [
        { key: 'persona' as FillChipKey, label: '人物画像', filled: false },
        { key: 'birthday' as FillChipKey, label: '生日', filled: false },
        { key: 'body' as FillChipKey, label: '身高体重', filled: false },
        {
          key: 'dietary' as FillChipKey,
          label: '饮食偏好',
          filled: !dietaryEmpty,
        },
      ],
      completeness: [
        { key: 'birthday', label: '生日', filled: false },
        { key: 'height', label: '身高', filled: false },
        { key: 'weight', label: '体重', filled: false },
        { key: 'persona', label: '人物画像', filled: false },
        { key: 'dietary', label: '饮食偏好', filled: !dietaryEmpty },
      ],
      archive: null,
      dietary: {
        empty: dietaryEmpty,
        summary: dietarySummary,
        prefs: dietary,
      },
      weight_trend: weightBundle
        ? {
            latest_kg: weightBundle.latest_kg,
            last_record_ymd: weightBundle.last_record_ymd,
            delta_kg: weightBundle.delta_kg,
            points: weightBundle.points,
          }
        : { latest_kg: null, last_record_ymd: null, delta_kg: null, points: [] },
      week,
      note: '无 users 行；资料缺口按全缺返回。',
    };
  }

  const birthday = trimStr(user.birthday, 32);
  const height = asNum(user.height);
  const weight = asNum(user.weight);
  const persona = trimStr(user.persona_portrait, 500);
  const birthdayFilled = Boolean(birthday);
  const heightFilled = height > 0;
  const weightFilled = weight > 0;
  const bodyFilled = heightFilled && weightFilled;
  const personaFilled = Boolean(persona);
  const dietaryFilled = !dietaryEmpty;

  const fillChips = [
    { key: 'persona' as FillChipKey, label: '人物画像', filled: personaFilled },
    { key: 'dietary' as FillChipKey, label: '饮食偏好', filled: dietaryFilled },
    { key: 'birthday' as FillChipKey, label: '生日', filled: birthdayFilled },
    { key: 'body' as FillChipKey, label: '身高体重', filled: bodyFilled },
  ];

  const completenessItems = [
    { key: 'birthday', label: '生日', filled: birthdayFilled },
    { key: 'height', label: '身高', filled: heightFilled },
    { key: 'weight', label: '体重', filled: weightFilled },
    { key: 'persona', label: '人物画像', filled: personaFilled },
    { key: 'dietary', label: '饮食偏好', filled: dietaryFilled },
  ];
  const filledCount = completenessItems.filter((c) => c.filled).length;
  const totalCount = completenessItems.length;
  const completenessPercent =
    totalCount === 0 ? 0 : Math.round((filledCount / totalCount) * 100);

  const lifestyle = trimStr(user.lifestyle, 40);
  const goal = trimStr(user.goal, 20);
  const workoutDays = parseWorkoutDays(user.workout_days);
  const latestKg =
    weightBundle?.latest_kg != null
      ? weightBundle.latest_kg
      : weightFilled
        ? weight
        : null;
  const bmi = calcBmi(height, latestKg ?? 0);

  return {
    domain: 'profile',
    today_ymd: today,
    has_user: true,
    completeness_percent: completenessPercent,
    filled_count: filledCount,
    total_count: totalCount,
    missing_count: Math.max(0, totalCount - filledCount),
    fill_chips: fillChips,
    completeness: completenessItems,
    filled_summary: {
      persona: personaFilled,
      birthday: birthdayFilled,
      body: bodyFilled,
      dietary: dietaryFilled,
      lifestyle: lifestyle || null,
      goal: goal || null,
    },
    archive: {
      name: trimStr(user.name, 40) || null,
      gender: trimStr(user.gender, 8) || null,
      lifestyle: lifestyle || null,
      goal: goal || null,
      birthday: birthday || null,
      height_cm: heightFilled ? height : null,
      weight_kg: latestKg,
      age: asNum(user.age) || null,
      bmi,
      persona_filled: personaFilled,
      persona_char_count: persona.length,
      persona_one_liner: oneLiner(persona),
      has_avatar: Boolean(trimStr(user.avatar_uri, 8)),
      workout_days: workoutDays.length ? workoutDays : null,
      workout_days_label: workoutDays.length ? workoutDays.join(' / ') : '未设置',
      rest_days: trimStr(user.rest_days, 80) || null,
      dietary_summary: dietarySummary,
      dietary_empty: dietaryEmpty,
    },
    dietary: {
      empty: dietaryEmpty,
      summary: dietarySummary,
      prefs: dietary,
    },
    body: {
      height_cm: heightFilled ? height : null,
      weight_kg: latestKg,
      bmi,
      age: asNum(user.age) || null,
    },
    weight_trend: weightBundle
      ? {
          latest_kg: weightBundle.latest_kg ?? latestKg,
          last_record_ymd: weightBundle.last_record_ymd,
          delta_kg: weightBundle.delta_kg,
          points: weightBundle.points,
        }
      : {
          latest_kg: latestKg,
          last_record_ymd: null,
          delta_kg: null,
          points: [] as { ymd: string; weight_kg: number }[],
        },
    week,
    note:
      '资料只读摘要（含饮食偏好 / 体重趋势 / 本周节奏）。改资料须用户确认后写库；助手不静默写库。',
  };
}

// re-export helpers for pages that need summary formatting
export { formatDietaryPrefsSummary, isDietaryPrefsEmpty };
