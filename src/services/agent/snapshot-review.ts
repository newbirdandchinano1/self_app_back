/**
 * Agent 只读复盘快照：日/周/月是否已写、维度空栏提示（不含正文）。
 * 挂载：GET /api/app/agent/snapshot/review
 */
import {
  getReviewHome,
  ReviewPageError,
  type ReviewHomeParams,
} from '../pages/review.js';
import { getReviewSettings } from '../review-settings.js';
import {
  loadReviewDayFacts,
  reviewDayFactsIsEmpty,
  reviewDayFactsPreviewLines,
} from '../review-facts.js';

export type AgentReviewSnapshotParams = ReviewHomeParams;

export { ReviewPageError as ReviewSnapshotError };

function nonEmptyText(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).replace(/[{}\[\]",:\s]/g, '').length > 0;
    } catch {
      return false;
    }
  }
  return String(v).trim().length > 0;
}

function journalHasContent(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  const keys = [
    'body',
    'extra_data',
    'section_summary',
    'section_plans',
    'section_reflect',
    'section_learnings',
    'section_next_week',
    'ai_coaching',
  ];
  return keys.some((k) => nonEmptyText(row[k]));
}

export async function getAgentReviewSnapshot(params: AgentReviewSnapshotParams = {}) {
  const home = await getReviewHome(params);
  const meta = home.meta as {
    logicalToday?: string;
    weekStart?: string;
    monthStart?: string;
    dailyStart?: string;
    dailyEnd?: string;
  };
  const today = String(meta.logicalToday || '').trim();

  const dailyRows = Array.isArray(home.dailyJournals) ? home.dailyJournals : [];
  const todayRow = dailyRows.find((row) => {
    const r = row as Record<string, unknown>;
    return String(r.record_date_ymd || '').trim() === today;
  }) as Record<string, unknown> | undefined;

  const weekly = (home.weeklyJournal || null) as Record<string, unknown> | null;
  const monthly = (home.monthlyJournal || null) as Record<string, unknown> | null;

  const dailyWritten = journalHasContent(todayRow);
  const weeklyWritten = journalHasContent(weekly);
  const monthlyWritten = journalHasContent(monthly);

  const dimensions = (Array.isArray(home.dimensions) ? home.dimensions : []).map((d) => {
    const row = d as Record<string, unknown>;
    return {
      id: row.id == null ? null : String(row.id),
      title: String(row.title ?? '').trim() || '维度',
      scope: String(row.scope ?? '').trim() || null,
      sort_order: Number(row.sort_order) || 0,
    };
  });

  const columns = (Array.isArray(home.columns) ? home.columns : []).map((c) => {
    const row = c as Record<string, unknown>;
    return {
      id: row.id == null ? null : String(row.id),
      dimension_id: row.dimension_id == null ? null : String(row.dimension_id),
      title: String(row.title ?? '').trim() || '栏目',
      sort_order: Number(row.sort_order) || 0,
    };
  });

  const dailyDims = dimensions.filter((d) => d.scope === 'daily');
  const empty_dimension_hints = dailyWritten
    ? []
    : dailyDims.slice(0, 8).map((d) => ({
        dimension_id: d.id,
        title: d.title,
        hint: '今日日复盘尚未填写',
      }));

  let day_facts_preview: string[] = [];
  let day_facts_empty = true;
  if (today) {
    try {
      const facts = await loadReviewDayFacts(today);
      day_facts_empty = reviewDayFactsIsEmpty(facts);
      day_facts_preview = reviewDayFactsPreviewLines(facts);
    } catch {
      // 事实聚合失败不阻断 snapshot
    }
  }

  let settings_summary: {
    weekly_review_weekday: number | null;
    weekly_review_weekday_label: string | null;
    daily_reminder_enabled: boolean;
    weekly_reminder_enabled: boolean;
    points_enabled: boolean;
  } | null = null;
  try {
    const settings = await getReviewSettings();
    settings_summary = {
      weekly_review_weekday: settings.weekly_review_weekday,
      weekly_review_weekday_label: settings.weekly_review_weekday_label,
      daily_reminder_enabled: settings.daily_reminder.enabled,
      weekly_reminder_enabled: settings.weekly_reminder.enabled,
      points_enabled: settings.points.enabled,
    };
  } catch {
    settings_summary = null;
  }

  return {
    domain: 'review',
    today_ymd: today || null,
    week_start_ymd: meta.weekStart || null,
    month_start_ymd: meta.monthStart || null,
    daily: {
      written: dailyWritten,
      period_ymd: today || null,
    },
    weekly: {
      written: weeklyWritten,
      period_ymd: meta.weekStart || null,
    },
    monthly: {
      written: monthlyWritten,
      period_ymd: meta.monthStart || null,
    },
    empty_dimension_hints,
    dimension_titles: dailyDims.map((d) => d.title).filter(Boolean).slice(0, 12),
    catalog: {
      dimensions: dimensions.slice(0, 24),
      columns: columns.slice(0, 48),
    },
    day_facts: {
      empty: day_facts_empty,
      preview_lines: day_facts_preview,
    },
    settings: settings_summary,
    note: '复盘状态只读；事实详情 GET /review/day-facts；空栏写入 POST /review/fill-empty；设置 GET/PUT /review/settings。',
  };
}
