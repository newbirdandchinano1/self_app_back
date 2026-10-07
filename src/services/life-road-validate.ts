import type { RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';

/** 道路写入校验错误（由 CRUD 转为 CrudError） */
export class LifeRoadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'LifeRoadError';
  }
}

/** 今年进行中赌注上限（horizon=year 且 status ∈ on_track|paused） */
export const LIFE_BET_YEAR_ACTIVE_LIMIT = 5;

export const LIFE_BET_HORIZON_VALUES = ['year', 'multi', 'farther'] as const;
export type LifeBetHorizon = (typeof LIFE_BET_HORIZON_VALUES)[number];

export const LIFE_BET_STATUS_VALUES = ['on_track', 'paused', 'arrived', 'dropped'] as const;
export type LifeBetStatus = (typeof LIFE_BET_STATUS_VALUES)[number];

const ACTIVE_STATUSES = new Set<string>(['on_track', 'paused']);

function unicodeLen(text: string): number {
  return [...text].length;
}

function trimRequiredText(value: unknown, field: string, maxChars: number): string {
  if (value == null) {
    throw new LifeRoadError(`${field} 必填`, 400);
  }
  const text = String(value).trim();
  if (!text) {
    throw new LifeRoadError(`${field} 必填`, 400);
  }
  if (unicodeLen(text) > maxChars) {
    throw new LifeRoadError(`${field} 最多 ${maxChars} 字`, 400);
  }
  return text;
}

function trimOptionalText(value: unknown, field: string, maxChars: number): string | null {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (unicodeLen(text) > maxChars) {
    throw new LifeRoadError(`${field} 最多 ${maxChars} 字`, 400);
  }
  return text;
}

/**
 * 规范化 life_directions 写入字段（body / year_theme）。
 * 创建时 body 必填；更新时仅校验出现的字段。
 */
export function normalizeLifeDirectionWrite(
  result: Record<string, unknown>,
  isCreate: boolean,
): void {
  if (isCreate || 'body' in result) {
    result.body = trimRequiredText(result.body, 'body', 200);
  }
  if (isCreate || 'year_theme' in result) {
    result.year_theme = trimOptionalText(result.year_theme, 'year_theme', 40);
  }
}

/**
 * 规范化 life_bets 写入字段；不查库。
 * 限额校验见 assertLifeBetYearActiveLimit。
 */
export function normalizeLifeBetWrite(
  result: Record<string, unknown>,
  isCreate: boolean,
): void {
  if (isCreate || 'title' in result) {
    result.title = trimRequiredText(result.title, 'title', 40);
  }

  if (isCreate || 'horizon' in result) {
    const horizon = String(result.horizon ?? '').trim();
    if (!(LIFE_BET_HORIZON_VALUES as readonly string[]).includes(horizon)) {
      throw new LifeRoadError(
        `horizon 仅支持 ${LIFE_BET_HORIZON_VALUES.join(' / ')}`,
        400,
      );
    }
    result.horizon = horizon;
  }

  if (isCreate || 'status' in result) {
    const status = String(result.status ?? (isCreate ? 'on_track' : '')).trim();
    if (!(LIFE_BET_STATUS_VALUES as readonly string[]).includes(status)) {
      throw new LifeRoadError(
        `status 仅支持 ${LIFE_BET_STATUS_VALUES.join(' / ')}`,
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
      const n = typeof result.sort_order === 'number' ? result.sort_order : Number(result.sort_order);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new LifeRoadError('sort_order 必须为整数', 400);
      }
      result.sort_order = n;
    }
  } else if (isCreate) {
    result.sort_order = 1000;
  }

  if ('year' in result) {
    if (result.year == null || result.year === '') {
      result.year = null;
    } else {
      const y = typeof result.year === 'number' ? result.year : Number(result.year);
      if (!Number.isFinite(y) || !Number.isInteger(y) || y < 1970 || y > 2100) {
        throw new LifeRoadError('year 须为 1970–2100 的公历年', 400);
      }
      result.year = y;
    }
  }
}

type LifeBetRow = {
  horizon: string;
  year: number | null;
  status: string;
};

async function loadLifeBetRow(id: string): Promise<LifeBetRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT horizon, year, status FROM life_bets WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    horizon: String(row.horizon ?? ''),
    year: row.year == null || row.year === '' ? null : Number(row.year),
    status: String(row.status ?? ''),
  };
}

/**
 * 合并补丁后校验：horizon=year 时 year 必填；进行中今年条数 ≤ 5。
 * @param excludeId 更新时排除自身，避免改标题误触限额
 */
export async function assertLifeBetYearRules(
  payload: Record<string, unknown>,
  options: { isCreate: boolean; excludeId?: string },
): Promise<void> {
  let horizon = payload.horizon != null ? String(payload.horizon) : undefined;
  let year =
    'year' in payload
      ? payload.year == null || payload.year === ''
        ? null
        : Number(payload.year)
      : undefined;
  let status = payload.status != null ? String(payload.status) : undefined;

  if (!options.isCreate && options.excludeId) {
    const existing = await loadLifeBetRow(options.excludeId);
    if (!existing) {
      throw new LifeRoadError('记录不存在', 404);
    }
    horizon = horizon ?? existing.horizon;
    if (year === undefined) year = existing.year;
    status = status ?? existing.status;
  }

  if (!horizon) {
    throw new LifeRoadError('horizon 必填', 400);
  }
  if (!(LIFE_BET_HORIZON_VALUES as readonly string[]).includes(horizon)) {
    throw new LifeRoadError(`horizon 仅支持 ${LIFE_BET_HORIZON_VALUES.join(' / ')}`, 400);
  }

  if (horizon === 'year') {
    if (year == null || !Number.isFinite(year)) {
      throw new LifeRoadError('horizon=year 时 year（公历年）必填', 400);
    }
  }

  const finalStatus = status ?? 'on_track';
  if (!ACTIVE_STATUSES.has(finalStatus)) {
    return;
  }
  if (horizon !== 'year' || year == null) {
    return;
  }

  const params: unknown[] = [year];
  let excludeSql = '';
  if (options.excludeId) {
    excludeSql = ' AND id != ?';
    params.push(options.excludeId);
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM life_bets
     WHERE horizon = 'year'
       AND year = ?
       AND status IN ('on_track', 'paused')
       ${excludeSql}`,
    params,
  );
  const cnt = Number(rows[0]?.cnt ?? 0);
  if (cnt >= LIFE_BET_YEAR_ACTIVE_LIMIT) {
    throw new LifeRoadError(
      `今年进行中的道路赌注最多 ${LIFE_BET_YEAR_ACTIVE_LIMIT} 条（在路上/暂搁）；已抵达或放弃不占名额`,
      400,
    );
  }
}

