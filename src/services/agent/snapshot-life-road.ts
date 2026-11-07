/**
 * Agent 只读人生道路快照：总方向 / 今年焦点 / 节点计数（不含长正文偷写）。
 * 挂载：GET /api/app/agent/snapshot/life_road
 */
import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { formatLocalYmdFromDate } from '../calendar/logical-day.js';

export class LifeRoadSnapshotError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'LifeRoadSnapshotError';
  }
}

export type AgentLifeRoadSnapshotParams = {
  limit?: number;
  calendarYear?: number;
};

const ACTIVE_SQL = `(sync_status IS NULL OR sync_status != 'pending_delete')`;

function trimStr(v: unknown, max = 200): string {
  return String(v ?? '')
    .trim()
    .slice(0, max);
}

function asInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function oneLiner(body: string, max = 80): string | null {
  const s = body.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

type NodeRow = {
  id: string;
  kind: string;
  title: string;
  note: string | null;
  calendar_year: number | null;
  quarter: number | null;
  month: number | null;
  parent_id: string | null;
  status: string;
  sort_order: number;
};

function trimNode(row: RowDataPacket): NodeRow {
  return {
    id: String(row.id),
    kind: trimStr(row.kind, 16) || 'month',
    title: trimStr(row.title, 40) || '未命名节点',
    note: trimStr(row.note, 200) || null,
    calendar_year: asInt(row.calendar_year),
    quarter: asInt(row.quarter),
    month: asInt(row.month),
    parent_id: row.parent_id == null ? null : String(row.parent_id),
    status: trimStr(row.status, 16) || 'on_track',
    sort_order: asInt(row.sort_order) ?? 1000,
  };
}

/** 挑选今年焦点：优先月 → 季 → 年 */
function pickYearFocus(
  nodes: NodeRow[],
  year: number,
  todayMonth: number,
): {
  yearFocus: string | null;
  focusKind: 'month' | 'quarter' | 'year' | null;
  focusTag: string | null;
  focusNodeId: string | null;
} {
  const active = nodes.filter(
    (n) =>
      n.calendar_year === year &&
      n.status !== 'dropped' &&
      (n.kind === 'month' || n.kind === 'quarter' || n.kind === 'year'),
  );
  const monthNode =
    active.find((n) => n.kind === 'month' && n.month === todayMonth) ||
    active.filter((n) => n.kind === 'month').sort((a, b) => (b.month ?? 0) - (a.month ?? 0))[0];
  if (monthNode) {
    return {
      yearFocus: monthNode.title,
      focusKind: 'month',
      focusTag: monthNode.month != null ? `${monthNode.month} 月` : null,
      focusNodeId: monthNode.id,
    };
  }
  const q = Math.ceil(todayMonth / 3);
  const quarterNode =
    active.find((n) => n.kind === 'quarter' && n.quarter === q) ||
    active.filter((n) => n.kind === 'quarter').sort((a, b) => (b.quarter ?? 0) - (a.quarter ?? 0))[0];
  if (quarterNode) {
    return {
      yearFocus: quarterNode.title,
      focusKind: 'quarter',
      focusTag: quarterNode.quarter != null ? `Q${quarterNode.quarter}` : null,
      focusNodeId: quarterNode.id,
    };
  }
  const yearNode = active.find((n) => n.kind === 'year');
  if (yearNode) {
    return {
      yearFocus: yearNode.title,
      focusKind: 'year',
      focusTag: String(year),
      focusNodeId: yearNode.id,
    };
  }
  return { yearFocus: null, focusKind: null, focusTag: null, focusNodeId: null };
}

export async function getAgentLifeRoadSnapshot(params: AgentLifeRoadSnapshotParams = {}) {
  const lim = Math.max(1, Math.min(Number(params.limit) || 40, 80));
  const today = formatLocalYmdFromDate(new Date());
  const year =
    params.calendarYear && Number.isFinite(params.calendarYear)
      ? Math.trunc(params.calendarYear)
      : Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7)) || 1;

  const [dirRows] = await db.query<RowDataPacket[]>(
    `SELECT id, body, year_theme, updated_at
     FROM life_directions
     WHERE ${ACTIVE_SQL}
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  const dir = dirRows[0] ?? null;
  const directionBody = dir ? trimStr(dir.body, 200) : '';
  const yearTheme = dir ? trimStr(dir.year_theme, 40) : '';

  const [nodeRows] = await db.query<RowDataPacket[]>(
    `SELECT id, kind, title, note, calendar_year, quarter, month, parent_id, status, sort_order
     FROM life_road_nodes
     WHERE ${ACTIVE_SQL}
     ORDER BY sort_order ASC, updated_at DESC
     LIMIT ?`,
    [lim],
  );
  const nodes = (nodeRows || []).map(trimNode);
  const yearNodes = nodes.filter(
    (n) => n.calendar_year === year && (n.kind === 'year' || n.kind === 'quarter' || n.kind === 'month'),
  );
  const aboveYear = nodes.filter((n) => n.kind === 'multi' || n.kind === 'farther');
  const statusCounts: Record<string, number> = {};
  for (const n of yearNodes) {
    statusCounts[n.status] = (statusCounts[n.status] || 0) + 1;
  }
  const arrived = yearNodes.filter((n) => n.status === 'arrived');
  const focus = pickYearFocus(nodes, year, todayMonth);

  const nodeSummaries = yearNodes.slice(0, 24).map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    status: n.status,
    calendar_year: n.calendar_year,
    quarter: n.quarter,
    month: n.month,
    parent_id: n.parent_id,
    has_note: Boolean(n.note),
  }));

  const monthsWithContent = [
    ...new Set(
      yearNodes
        .filter((n) => n.kind === 'month' && n.month != null && n.status !== 'dropped')
        .map((n) => n.month as number),
    ),
  ].sort((a, b) => a - b);

  return {
    domain: 'life_road',
    today_ymd: today,
    calendar_year: year,
    has_direction: Boolean(directionBody),
    direction: directionBody
      ? {
          id: dir ? String(dir.id) : null,
          body_one_liner: oneLiner(directionBody),
          body_char_count: directionBody.length,
          year_theme: yearTheme || null,
        }
      : null,
    // 供 L1 拆解用的短方向（截断）；完整正文仍在用户页内
    direction_body_brief: directionBody ? directionBody.slice(0, 200) : null,
    year_theme: yearTheme || null,
    focus: {
      year_focus: focus.yearFocus,
      focus_kind: focus.focusKind,
      focus_tag: focus.focusTag,
      focus_node_id: focus.focusNodeId,
      road_focus_line: focus.yearFocus
        ? [focus.focusTag, focus.yearFocus].filter(Boolean).join(' · ')
        : yearTheme
          ? `年主题 · ${yearTheme}`
          : directionBody
            ? oneLiner(directionBody)
            : null,
    },
    counts: {
      year_node_count: yearNodes.filter((n) => n.status !== 'dropped').length,
      arrived_count: arrived.length,
      above_year_count: aboveYear.filter((n) => n.status !== 'dropped').length,
      status_counts: statusCounts,
    },
    arrived_titles: arrived.map((n) => n.title).slice(0, 12),
    months_with_content: monthsWithContent,
    node_summaries: nodeSummaries,
    existing_node_titles: yearNodes.map((n) => n.title).filter(Boolean).slice(0, 40),
    note: '人生道路只读摘要。排节点/改节点须用户在道路页确认；助手不写库。',
  };
}
