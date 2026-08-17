import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  formatDbDateTimeForApi,
  formatRecordDateTimesForApi,
  formatUtcMySQLDateTime,
} from './calendar/logical-day.js';
import { AiScenarioError, analyzeMemoReviewFromText } from './zhipu/scenarios.js';

export class MemoError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'MemoError';
  }
}

type DimensionRow = {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  sync_status: string;
  version: number;
};

type MemoRow = {
  id: string;
  title: string;
  body: string;
  ai_evaluation: string | null;
  ai_suggestions: string | null;
  ai_review_at: string | null;
  linked_task_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  sync_status: string;
  version: number;
  dimension: string | null;
  dimension_id: string | null;
};

function nowUtcMysql(): string {
  return formatUtcMySQLDateTime(new Date());
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseSortOrder(value: unknown, fallback = 1000): number {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new MemoError('sort_order 必须是数字');
  return Math.trunc(n);
}

function formatDimension(row: DimensionRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      name: row.name,
      sort_order: Number(row.sort_order ?? 1000),
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      version: Number(row.version ?? 1),
    },
    'memo_dimensions',
  );
}

function formatMemo(row: MemoRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      title: row.title,
      body: row.body,
      ai_evaluation: row.ai_evaluation,
      ai_suggestions: row.ai_suggestions,
      ai_review_at: row.ai_review_at,
      linked_task_id: row.linked_task_id,
      dimension: row.dimension,
      dimension_id: row.dimension_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      version: Number(row.version ?? 1),
    },
    'memos',
  );
}

async function getActiveDimension(id: string): Promise<DimensionRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, sort_order, created_at, updated_at, deleted_at, sync_status, version
     FROM memo_dimensions
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return (rows[0] as DimensionRow | undefined) ?? null;
}

async function getActiveMemo(id: string): Promise<MemoRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, title, body, ai_evaluation, ai_suggestions, ai_review_at, linked_task_id,
            created_at, updated_at, deleted_at, sync_status, version, dimension, dimension_id
     FROM memos
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return (rows[0] as MemoRow | undefined) ?? null;
}

/** 获取全部备忘录维度 */
export async function listMemoDimensions() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, sort_order, created_at, updated_at, deleted_at, sync_status, version
     FROM memo_dimensions
     WHERE deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
  return (rows as DimensionRow[]).map(formatDimension);
}

/** 新建备忘录维度 */
export async function createMemoDimension(input: {
  id?: unknown;
  name: unknown;
  sort_order?: unknown;
}) {
  const name = asTrimmedString(input.name);
  if (!name) throw new MemoError('name 不能为空');

  const id = asTrimmedString(input.id) || randomUUID();
  const sortOrder = parseSortOrder(input.sort_order, 1000);
  const now = nowUtcMysql();

  try {
    await db.query(
      `INSERT INTO memo_dimensions
         (id, name, sort_order, created_at, updated_at, deleted_at, sync_status, version)
       VALUES (?, ?, ?, ?, ?, NULL, 'synced', 1)`,
      [id, name, sortOrder, now, now],
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new MemoError('备忘录维度已存在', 409);
    }
    throw err;
  }

  const created = await getActiveDimension(id);
  if (!created) throw new MemoError('创建备忘录维度失败', 500);
  return formatDimension(created);
}

/** 修改备忘录维度 */
export async function updateMemoDimension(
  dimensionId: string,
  input: { name?: unknown; sort_order?: unknown },
) {
  const id = dimensionId.trim();
  if (!id) throw new MemoError('id 不能为空');

  const existing = await getActiveDimension(id);
  if (!existing) throw new MemoError('备忘录维度不存在', 404);

  const updates: string[] = [];
  const values: unknown[] = [];
  let nextName: string | null = null;

  if (input.name !== undefined) {
    const name = asTrimmedString(input.name);
    if (!name) throw new MemoError('name 不能为空');
    updates.push('name = ?');
    values.push(name);
    nextName = name;
  }
  if (input.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(parseSortOrder(input.sort_order, existing.sort_order));
  }

  if (updates.length === 0) throw new MemoError('没有可更新的字段');

  const now = nowUtcMysql();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE memo_dimensions
       SET ${updates.join(', ')}, updated_at = ?, version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [...values, now, id],
    );

    if (nextName != null) {
      await conn.query(
        `UPDATE memos
         SET dimension = ?, updated_at = ?, version = version + 1
         WHERE dimension_id = ? AND deleted_at IS NULL`,
        [nextName, now, id],
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const updated = await getActiveDimension(id);
  if (!updated) throw new MemoError('备忘录维度不存在', 404);
  return formatDimension(updated);
}

/** 删除备忘录维度（软删，并级联软删其下备忘） */
export async function deleteMemoDimension(dimensionId: string) {
  const id = dimensionId.trim();
  if (!id) throw new MemoError('id 不能为空');

  const existing = await getActiveDimension(id);
  if (!existing) throw new MemoError('备忘录维度不存在', 404);

  const now = nowUtcMysql();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE memos
       SET deleted_at = ?, updated_at = ?, version = version + 1
       WHERE dimension_id = ? AND deleted_at IS NULL`,
      [now, now, id],
    );
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE memo_dimensions
       SET deleted_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND deleted_at IS NULL`,
      [now, now, id],
    );
    await conn.commit();
    if (result.affectedRows === 0) throw new MemoError('备忘录维度不存在', 404);
    return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** 获取所有备忘录列表 */
export async function listMemos() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, title, body, ai_evaluation, ai_suggestions, ai_review_at, linked_task_id,
            created_at, updated_at, deleted_at, sync_status, version, dimension, dimension_id
     FROM memos
     WHERE deleted_at IS NULL
     ORDER BY updated_at DESC, created_at DESC, id ASC`,
  );
  return (rows as MemoRow[]).map(formatMemo);
}

/** 获取指定维度的备忘录列表 */
export async function listMemosByDimension(dimensionId: string) {
  const id = dimensionId.trim();
  if (!id) throw new MemoError('dimensionId 不能为空');

  const dimension = await getActiveDimension(id);
  if (!dimension) throw new MemoError('备忘录维度不存在', 404);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, title, body, ai_evaluation, ai_suggestions, ai_review_at, linked_task_id,
            created_at, updated_at, deleted_at, sync_status, version, dimension, dimension_id
     FROM memos
     WHERE dimension_id = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC, created_at DESC, id ASC`,
    [id],
  );

  return {
    dimension: formatDimension(dimension),
    items: (rows as MemoRow[]).map(formatMemo),
  };
}

/** 备忘录详情 */
export async function getMemoDetail(memoId: string) {
  const id = memoId.trim();
  if (!id) throw new MemoError('id 不能为空');

  const memo = await getActiveMemo(id);
  if (!memo) throw new MemoError('备忘录不存在', 404);

  const dimensionId = memo.dimension_id == null ? '' : String(memo.dimension_id).trim();
  const dimension = dimensionId ? await getActiveDimension(dimensionId) : null;

  return {
    ...formatMemo(memo),
    dimension_detail: dimension ? formatDimension(dimension) : null,
  };
}

export type CreateMemoInput = {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  dimension_id?: unknown;
  linked_task_id?: unknown;
};

/** 新建备忘 */
export async function createMemo(input: CreateMemoInput) {
  const title = asTrimmedString(input.title);
  const body = typeof input.body === 'string' ? input.body : '';
  if (!title && !body.trim()) throw new MemoError('title 与 body 不能同时为空');

  let dimensionId: string | null = null;
  let dimensionName: string | null = null;
  if (input.dimension_id !== undefined && input.dimension_id != null && input.dimension_id !== '') {
    dimensionId = asTrimmedString(input.dimension_id);
    if (!dimensionId) throw new MemoError('dimension_id 不能为空');
    const dimension = await getActiveDimension(dimensionId);
    if (!dimension) throw new MemoError('备忘录维度不存在', 404);
    dimensionName = dimension.name;
  }

  const linkedTaskId =
    input.linked_task_id == null || input.linked_task_id === ''
      ? null
      : asTrimmedString(input.linked_task_id) || null;

  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();

  try {
    await db.query(
      `INSERT INTO memos
         (id, title, body, ai_evaluation, ai_suggestions, ai_review_at, linked_task_id,
          created_at, updated_at, deleted_at, sync_status, version, dimension, dimension_id)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, 'synced', 1, ?, ?)`,
      [id, title, body, linkedTaskId, now, now, dimensionName, dimensionId],
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new MemoError('备忘录已存在', 409);
    }
    throw err;
  }

  const created = await getActiveMemo(id);
  if (!created) throw new MemoError('创建备忘录失败', 500);
  return formatMemo(created);
}

export type UpdateMemoInput = {
  title?: unknown;
  body?: unknown;
  dimension_id?: unknown;
  linked_task_id?: unknown;
};

/** 修改备忘 */
export async function updateMemo(memoId: string, input: UpdateMemoInput) {
  const id = memoId.trim();
  if (!id) throw new MemoError('id 不能为空');

  const existing = await getActiveMemo(id);
  if (!existing) throw new MemoError('备忘录不存在', 404);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    updates.push('title = ?');
    values.push(asTrimmedString(input.title));
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string') throw new MemoError('body 必须是字符串');
    updates.push('body = ?');
    values.push(input.body);
  }
  if (input.dimension_id !== undefined) {
    if (input.dimension_id == null || input.dimension_id === '') {
      updates.push('dimension_id = ?', 'dimension = ?');
      values.push(null, null);
    } else {
      const dimensionId = asTrimmedString(input.dimension_id);
      if (!dimensionId) throw new MemoError('dimension_id 不能为空');
      const dimension = await getActiveDimension(dimensionId);
      if (!dimension) throw new MemoError('备忘录维度不存在', 404);
      updates.push('dimension_id = ?', 'dimension = ?');
      values.push(dimensionId, dimension.name);
    }
  }
  if (input.linked_task_id !== undefined) {
    updates.push('linked_task_id = ?');
    values.push(
      input.linked_task_id == null || input.linked_task_id === ''
        ? null
        : asTrimmedString(input.linked_task_id) || null,
    );
  }

  if (updates.length === 0) throw new MemoError('没有可更新的字段');

  const now = nowUtcMysql();
  updates.push('updated_at = ?', 'version = version + 1');
  values.push(now, id);

  const [result] = await db.query<ResultSetHeader>(
    `UPDATE memos
     SET ${updates.join(', ')}
     WHERE id = ? AND deleted_at IS NULL`,
    values,
  );
  if (result.affectedRows === 0) throw new MemoError('备忘录不存在', 404);

  const updated = await getActiveMemo(id);
  if (!updated) throw new MemoError('备忘录不存在', 404);
  return formatMemo(updated);
}

/** 删除备忘（软删） */
export async function deleteMemo(memoId: string) {
  const id = memoId.trim();
  if (!id) throw new MemoError('id 不能为空');

  const existing = await getActiveMemo(id);
  if (!existing) throw new MemoError('备忘录不存在', 404);

  const now = nowUtcMysql();
  const [result] = await db.query<ResultSetHeader>(
    `UPDATE memos
     SET deleted_at = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND deleted_at IS NULL`,
    [now, now, id],
  );
  if (result.affectedRows === 0) throw new MemoError('备忘录不存在', 404);

  return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
}

function buildMemoContextText(memo: MemoRow): string {
  const title = memo.title?.trim() || '(无标题)';
  const body = memo.body ?? '';
  const dim = memo.dimension?.trim();
  const parts = [
    dim ? `维度：${dim}` : null,
    `标题：${title}`,
    `正文：\n${body}`,
  ].filter(Boolean);
  return parts.join('\n');
}

/**
 * AI 分析备忘并存库（写入 ai_evaluation / ai_suggestions / ai_review_at）
 * 复用 analyzeMemoReviewFromText
 */
export async function analyzeAndPersistMemoReview(memoId: string) {
  const id = memoId.trim();
  if (!id) throw new MemoError('id 不能为空');

  const memo = await getActiveMemo(id);
  if (!memo) throw new MemoError('备忘录不存在', 404);

  const contextText = buildMemoContextText(memo);
  if (!contextText.trim()) throw new MemoError('备忘内容为空');

  let evaluation: string;
  let suggestions: string;
  try {
    const result = await analyzeMemoReviewFromText(contextText);
    evaluation = result.evaluation;
    suggestions = result.suggestions;
  } catch (err) {
    if (err instanceof AiScenarioError) {
      throw new MemoError(err.message, err.httpStatus);
    }
    throw err;
  }

  const now = nowUtcMysql();
  const [result] = await db.query<ResultSetHeader>(
    `UPDATE memos
     SET ai_evaluation = ?, ai_suggestions = ?, ai_review_at = ?,
         updated_at = ?, version = version + 1
     WHERE id = ? AND deleted_at IS NULL`,
    [evaluation, suggestions, now, now, id],
  );
  if (result.affectedRows === 0) throw new MemoError('备忘录不存在', 404);

  const updated = await getActiveMemo(id);
  if (!updated) throw new MemoError('备忘录不存在', 404);
  return formatMemo(updated);
}
