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
  is_pinned?: number | null;
};

function coercePinned(value: unknown): number {
  if (value === true || value === 1 || value === '1') return 1;
  return 0;
}

function nowUtcMysql(): string {
  return formatUtcMySQLDateTime(new Date());
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
      /** 兼容旧客户端；分类以 tags/tag_links 为准 */
      dimension: null,
      dimension_id: null,
      is_pinned: coercePinned(row.is_pinned),
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      version: Number(row.version ?? 1),
    },
    'memos',
  );
}

let memosPinnedEnsure: Promise<void> | null = null;
function ensureMemosPinnedOnce(): Promise<void> {
  if (!memosPinnedEnsure) {
    memosPinnedEnsure = import('../db/ensure-memos-pinned.js')
      .then((m) => m.ensureMemosPinnedColumn())
      .catch((err) => {
        memosPinnedEnsure = null;
        throw err;
      });
  }
  return memosPinnedEnsure;
}

let tagsTablesEnsure: Promise<void> | null = null;
function ensureTagsTablesOnce(): Promise<void> {
  if (!tagsTablesEnsure) {
    tagsTablesEnsure = import('../db/ensure-project-tags.js')
      .then((m) => m.ensureProjectTagsTables())
      .catch((err) => {
        tagsTablesEnsure = null;
        throw err;
      });
  }
  return tagsTablesEnsure;
}

async function getActiveMemo(id: string): Promise<MemoRow | null> {
  await ensureMemosPinnedOnce();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, title, body, ai_evaluation, ai_suggestions, ai_review_at, linked_task_id,
            created_at, updated_at, deleted_at, sync_status, version, dimension, dimension_id,
            COALESCE(is_pinned, 0) AS is_pinned
     FROM memos
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return (rows[0] as MemoRow | undefined) ?? null;
}

/** 获取所有备忘录列表 */
export async function listMemos() {
  await ensureMemosPinnedOnce();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, title, body, ai_evaluation, ai_suggestions, ai_review_at, linked_task_id,
            created_at, updated_at, deleted_at, sync_status, version, dimension, dimension_id,
            COALESCE(is_pinned, 0) AS is_pinned
     FROM memos
     WHERE deleted_at IS NULL
     ORDER BY COALESCE(is_pinned, 0) DESC, updated_at DESC, created_at DESC, id ASC`,
  );
  return (rows as MemoRow[]).map(formatMemo);
}

/** 标签列表（备忘 / 项目共用权威表；profile 聚合与通用 List 同源） */
export async function listTags() {
  await ensureTagsTablesOnce();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, color, description, weight, created_at, updated_at, sync_status, extra_data
     FROM tags
     WHERE sync_status IS NULL OR sync_status != 'pending_delete'
     ORDER BY name ASC, id ASC`,
  );
  return (rows as Record<string, unknown>[]).map((row) =>
    formatRecordDateTimesForApi({ ...row }, 'tags'),
  );
}

/** 标签关联列表 */
export async function listTagLinks() {
  await ensureTagsTablesOnce();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, entity_type, entity_id, tag_id, created_at, updated_at, sync_status
     FROM tag_links
     WHERE sync_status IS NULL OR sync_status != 'pending_delete'
     ORDER BY updated_at DESC, id DESC`,
  );
  return (rows as Record<string, unknown>[]).map((row) =>
    formatRecordDateTimesForApi({ ...row }, 'tag_links'),
  );
}

/** 备忘录详情 */
export async function getMemoDetail(memoId: string) {
  const id = memoId.trim();
  if (!id) throw new MemoError('id 不能为空');

  const memo = await getActiveMemo(id);
  if (!memo) throw new MemoError('备忘录不存在', 404);

  return {
    ...formatMemo(memo),
    dimension_detail: null,
  };
}

export type CreateMemoInput = {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  /** @deprecated 已忽略；分类走 tags */
  dimension_id?: unknown;
  linked_task_id?: unknown;
  is_pinned?: unknown;
};

/** 新建备忘 */
export async function createMemo(input: CreateMemoInput) {
  const title = asTrimmedString(input.title);
  const body = typeof input.body === 'string' ? input.body : '';
  if (!title && !body.trim()) throw new MemoError('title 与 body 不能同时为空');

  const linkedTaskId =
    input.linked_task_id == null || input.linked_task_id === ''
      ? null
      : asTrimmedString(input.linked_task_id) || null;

  const isPinned = coercePinned(input.is_pinned);
  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();

  try {
    await db.query(
      `INSERT INTO memos
         (id, title, body, ai_evaluation, ai_suggestions, ai_review_at, linked_task_id,
          created_at, updated_at, deleted_at, sync_status, version, dimension, dimension_id, is_pinned)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, 'synced', 1, NULL, NULL, ?)`,
      [id, title, body, linkedTaskId, now, now, isPinned],
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
  /** @deprecated 已忽略；写入时清空维度列 */
  dimension_id?: unknown;
  linked_task_id?: unknown;
  is_pinned?: unknown;
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
  // 维度已下线：任意更新都清空遗留列，避免与 tags 双写
  updates.push('dimension_id = ?', 'dimension = ?');
  values.push(null, null);

  if (input.linked_task_id !== undefined) {
    updates.push('linked_task_id = ?');
    values.push(
      input.linked_task_id == null || input.linked_task_id === ''
        ? null
        : asTrimmedString(input.linked_task_id) || null,
    );
  }
  if (input.is_pinned !== undefined) {
    updates.push('is_pinned = ?');
    values.push(coercePinned(input.is_pinned));
  }

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
  const parts = [`标题：${title}`, `正文：\n${body}`];
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
