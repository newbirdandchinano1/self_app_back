/**
 * Agent 只读复盘快照：日/周/月是否已写、维度空栏提示（不含正文）。
 * 挂载：GET /api/app/agent/snapshot/review
 */
import {
  getReviewHome,
  ReviewPageError,
  type ReviewHomeParams,
} from '../pages/review.js';

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
    note: '复盘状态只读；起草/改写请用户提供栏目内容或打开复盘页，助手不从库偷正文写库。',
  };
}
