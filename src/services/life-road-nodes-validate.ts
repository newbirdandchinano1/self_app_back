import type { RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';

/** 道路节点写入校验错误（由 CRUD 转为 CrudError） */
export class LifeRoadNodesError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'LifeRoadNodesError';
  }
}

export const LIFE_ROAD_NODE_KIND_VALUES = [
  'multi',
  'farther',
  'year',
  'quarter',
  'month',
] as const;
export type LifeRoadNodeKind = (typeof LIFE_ROAD_NODE_KIND_VALUES)[number];

export const LIFE_ROAD_NODE_STATUS_VALUES = [
  'on_track',
  'paused',
  'arrived',
  'dropped',
] as const;

function unicodeLen(text: string): number {
  return [...text].length;
}

function trimRequiredText(value: unknown, field: string, maxChars: number): string {
  if (value == null) {
    throw new LifeRoadNodesError(`${field} 必填`, 400);
  }
  const text = String(value).trim();
  if (!text) {
    throw new LifeRoadNodesError(`${field} 必填`, 400);
  }
  if (unicodeLen(text) > maxChars) {
    throw new LifeRoadNodesError(`${field} 最多 ${maxChars} 字`, 400);
  }
  return text;
}

function trimOptionalText(value: unknown, field: string, maxChars: number): string | null {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (unicodeLen(text) > maxChars) {
    throw new LifeRoadNodesError(`${field} 最多 ${maxChars} 字`, 400);
  }
  return text;
}

function monthToQuarter(month: number): number {
  if (month <= 3) return 1;
  if (month <= 6) return 2;
  if (month <= 9) return 3;
  return 4;
}

/**
 * 规范化 life_road_nodes 写入字段；不查库。
 * 同槽唯一见 assertLifeRoadNodeSlotUnique。
 */
export function normalizeLifeRoadNodeWrite(
  result: Record<string, unknown>,
  isCreate: boolean,
): void {
  if (isCreate || 'title' in result) {
    result.title = trimRequiredText(result.title, 'title', 40);
  }

  if (isCreate || 'kind' in result) {
    const kind = String(result.kind ?? '').trim();
    if (!(LIFE_ROAD_NODE_KIND_VALUES as readonly string[]).includes(kind)) {
      throw new LifeRoadNodesError(
        `kind 仅支持 ${LIFE_ROAD_NODE_KIND_VALUES.join(' / ')}`,
        400,
      );
    }
    result.kind = kind;
  }

  if (isCreate || 'status' in result) {
    const status = String(result.status ?? (isCreate ? 'on_track' : '')).trim();
    if (!(LIFE_ROAD_NODE_STATUS_VALUES as readonly string[]).includes(status)) {
      throw new LifeRoadNodesError(
        `status 仅支持 ${LIFE_ROAD_NODE_STATUS_VALUES.join(' / ')}`,
        400,
      );
    }
    result.status = status;
  } else if (isCreate) {
    result.status = 'on_track';
  }

  if (isCreate || 'note' in result) {
    result.note = trimOptionalText(result.note, 'note', 200);
  }

  if (isCreate || 'sort_order' in result) {
    if (result.sort_order == null || result.sort_order === '') {
      if (isCreate) result.sort_order = 1000;
    } else {
      const n =
        typeof result.sort_order === 'number'
          ? result.sort_order
          : Number(result.sort_order);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new LifeRoadNodesError('sort_order 必须为整数', 400);
      }
      result.sort_order = n;
    }
  } else if (isCreate) {
    result.sort_order = 1000;
  }

  for (const field of ['calendar_year', 'quarter', 'month'] as const) {
    if (field in result) {
      if (result[field] == null || result[field] === '') {
        result[field] = null;
      } else {
        const n =
          typeof result[field] === 'number' ? result[field] : Number(result[field]);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          throw new LifeRoadNodesError(`${field} 须为整数`, 400);
        }
        result[field] = n;
      }
    }
  }

  if ('parent_id' in result) {
    if (result.parent_id == null || result.parent_id === '') {
      result.parent_id = null;
    } else {
      result.parent_id = String(result.parent_id).trim();
    }
  }

  const kind = result.kind != null ? String(result.kind) : undefined;
  if (!kind) return;

  if (kind === 'multi' || kind === 'farther') {
    result.calendar_year = null;
    result.quarter = null;
    result.month = null;
    result.parent_id = null;
    return;
  }

  if (kind === 'year') {
    if (result.calendar_year == null) {
      throw new LifeRoadNodesError('kind=year 时 calendar_year 必填', 400);
    }
    result.quarter = null;
    result.month = null;
    result.parent_id = null;
    return;
  }

  if (kind === 'quarter') {
    if (result.calendar_year == null || result.quarter == null) {
      throw new LifeRoadNodesError('kind=quarter 时 calendar_year 与 quarter 必填', 400);
    }
    const q = Number(result.quarter);
    if (q < 1 || q > 4) {
      throw new LifeRoadNodesError('quarter 须为 1–4', 400);
    }
    result.month = null;
    return;
  }

  if (kind === 'month') {
    if (result.calendar_year == null || result.month == null) {
      throw new LifeRoadNodesError('kind=month 时 calendar_year 与 month 必填', 400);
    }
    const m = Number(result.month);
    if (m < 1 || m > 12) {
      throw new LifeRoadNodesError('month 须为 1–12', 400);
    }
    result.quarter = monthToQuarter(m);
  }
}

type NodeSlot = {
  kind: string;
  calendar_year: number | null;
  quarter: number | null;
  month: number | null;
};

async function loadNodeSlot(id: string): Promise<NodeSlot | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT kind, calendar_year, quarter, month FROM life_road_nodes WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    kind: String(row.kind ?? ''),
    calendar_year:
      row.calendar_year == null || row.calendar_year === ''
        ? null
        : Number(row.calendar_year),
    quarter: row.quarter == null || row.quarter === '' ? null : Number(row.quarter),
    month: row.month == null || row.month === '' ? null : Number(row.month),
  };
}

/** 一年 / 一季 / 一月各至多一条内容节点 */
export async function assertLifeRoadNodeSlotUnique(
  payload: Record<string, unknown>,
  options: { isCreate: boolean; excludeId?: string },
): Promise<void> {
  let kind = payload.kind != null ? String(payload.kind) : undefined;
  let calendar_year =
    'calendar_year' in payload
      ? payload.calendar_year == null || payload.calendar_year === ''
        ? null
        : Number(payload.calendar_year)
      : undefined;
  let quarter =
    'quarter' in payload
      ? payload.quarter == null || payload.quarter === ''
        ? null
        : Number(payload.quarter)
      : undefined;
  let month =
    'month' in payload
      ? payload.month == null || payload.month === ''
        ? null
        : Number(payload.month)
      : undefined;

  if (!options.isCreate && options.excludeId) {
    const existing = await loadNodeSlot(options.excludeId);
    if (!existing) {
      throw new LifeRoadNodesError('记录不存在', 404);
    }
    kind = kind ?? existing.kind;
    if (calendar_year === undefined) calendar_year = existing.calendar_year;
    if (quarter === undefined) quarter = existing.quarter;
    if (month === undefined) month = existing.month;
  }

  if (!kind || kind === 'multi' || kind === 'farther') return;
  if (calendar_year == null) return;

  const params: unknown[] = [kind, calendar_year];
  let sql = `SELECT COUNT(*) AS cnt FROM life_road_nodes
    WHERE kind = ? AND calendar_year = ?`;
  if (kind === 'quarter') {
    if (quarter == null) return;
    sql += ' AND quarter = ?';
    params.push(quarter);
  }
  if (kind === 'month') {
    if (month == null) return;
    sql += ' AND month = ?';
    params.push(month);
  }
  if (options.excludeId) {
    sql += ' AND id != ?';
    params.push(options.excludeId);
  }

  const [rows] = await db.query<RowDataPacket[]>(sql, params);
  const cnt = Number(rows[0]?.cnt ?? 0);
  if (cnt >= 1) {
    throw new LifeRoadNodesError('该时间槽已有道路节点，请直接编辑', 400);
  }
}
