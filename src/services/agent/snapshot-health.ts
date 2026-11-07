/**
 * Agent 只读健康快照：今日摄入 vs 目标、近餐摘要。
 * 挂载：GET /api/app/agent/snapshot/health
 */
import {
  getDayHealthMetrics,
  HealthError,
  listIntakesByDay,
  listRecentIntakes,
} from '../health.js';
import { formatLocalYmdFromDate } from '../calendar/logical-day.js';
import { isValidYmd } from '../../utils/ymd.js';

const RECENT_MEAL_LIMIT = 5;

export type AgentHealthSnapshotParams = {
  /** YYYY-MM-DD；缺省上海日历今日 */
  date?: string;
  logicalToday?: string;
};

function gapOf(current: number, target: number | null | undefined): number | null {
  if (target == null || !(target > 0)) return null;
  return Math.max(0, target - current);
}

export async function getAgentHealthSnapshot(params: AgentHealthSnapshotParams = {}) {
  const rawDate = String(params.date || params.logicalToday || '').trim();
  const dayYmd =
    rawDate && isValidYmd(rawDate) ? rawDate : formatLocalYmdFromDate(new Date());

  const [metrics, dayIntakes, weekIntakes] = await Promise.all([
    getDayHealthMetrics({ date: dayYmd }),
    listIntakesByDay({ date: dayYmd }).catch(() => ({ items: [] as Array<Record<string, unknown>> })),
    listRecentIntakes({ days: 7 }).catch(() => null),
  ]);

  const intake = metrics.intake;
  const targets = metrics.targets;
  const tCal = targets ? Number(targets.target_calories ?? 0) : 0;
  const tPro = targets ? Number(targets.target_protein ?? 0) : 0;
  const tCarb = targets ? Number(targets.target_carbohydrate ?? 0) : 0;
  const tHydro = targets ? Number(targets.target_hydration ?? 0) : 0;

  const recentMeals = (Array.isArray(dayIntakes.items) ? dayIntakes.items : [])
    .slice(-RECENT_MEAL_LIMIT)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id == null ? null : String(r.id),
        title: String(r.intake_display_title ?? '').trim() || null,
        calories: Number(r.calories) || 0,
        protein_g: Number(r.protein) || 0,
        carbohydrate_g: Number(r.carbohydrate) || 0,
        hydration_ml: Number(r.hydration) || 0,
        record_date: r.record_date == null ? null : String(r.record_date),
      };
    });

  const mealTitles = recentMeals
    .map((m) => m.title)
    .filter((t): t is string => !!t)
    .slice(-3);

  return {
    domain: 'health',
    today_ymd: dayYmd,
    intake_count: metrics.intake_count,
    intake: {
      calories: Number(intake.calories) || 0,
      protein_g: Number(intake.protein) || 0,
      carbohydrate_g: Number(intake.carbohydrate) || 0,
      hydration_ml: Number(intake.hydration) || 0,
      recent_meal_summary: mealTitles.length ? mealTitles.join('、') : null,
    },
    targets: {
      calories: tCal,
      protein_g: tPro,
      carbohydrate_g: tCarb,
      hydration_ml: tHydro,
      source: targets?.source ?? null,
    },
    gaps: {
      calories: gapOf(Number(intake.calories) || 0, tCal),
      protein_g: gapOf(Number(intake.protein) || 0, tPro),
      carbohydrate_g: gapOf(Number(intake.carbohydrate) || 0, tCarb),
      hydration_ml: gapOf(Number(intake.hydration) || 0, tHydro),
    },
    recent_meals: recentMeals,
    week_intake_count: weekIntakes ? Number(weekIntakes.total) || 0 : null,
    week_range:
      weekIntakes && weekIntakes.start_ymd && weekIntakes.end_ymd
        ? { start_ymd: weekIntakes.start_ymd, end_ymd: weekIntakes.end_ymd }
        : null,
    note: '健康只读摘要；记摄入需用户确认，助手不写库。体重短评依赖请求附带的 context。',
    meta: {
      serverTime: new Date().toISOString(),
      logicalToday: dayYmd,
    },
  };
}

export { HealthError };
