/**
 * Agent 只读备忘快照：最近备忘标题/id（限条），不含正文全文。
 * 挂载：GET /api/app/agent/snapshot/memo
 */
import { listMemos, listTags, MemoError } from '../memos.js';
import { plainTextFromMemoBody } from '../memo-plain-text.js';

const RECENT_LIMIT = 12;
const TAG_LIMIT = 40;
const PREVIEW_MAX = 80;

export type AgentMemoSnapshotParams = {
  limit?: number;
};

export { MemoError as MemoSnapshotError };

function trimPreview(body: unknown): string | null {
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const plain = plainTextFromMemoBody(body).replace(/\s+/g, ' ').trim();
    if (!plain) return null;
    return plain.length > PREVIEW_MAX ? `${plain.slice(0, PREVIEW_MAX)}…` : plain;
  } catch {
    return null;
  }
}

export async function getAgentMemoSnapshot(params: AgentMemoSnapshotParams = {}) {
  const lim = Math.max(1, Math.min(Number(params.limit) || RECENT_LIMIT, 20));
  const [memos, tags] = await Promise.all([
    listMemos(),
    listTags().catch(() => [] as Array<Record<string, unknown>>),
  ]);

  const recent = (Array.isArray(memos) ? memos : []).slice(0, lim).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id == null ? null : String(r.id),
      title: String(r.title ?? '').trim() || '未命名备忘',
      is_pinned: Boolean(r.is_pinned),
      updated_at: r.updated_at == null ? null : String(r.updated_at),
      has_ai_review: Boolean(r.ai_evaluation || r.ai_review_at),
      linked_task_id: r.linked_task_id == null ? null : String(r.linked_task_id),
      /** 短预览仅供去重/洞察线索，非权威全文 */
      preview: trimPreview(r.body),
    };
  });

  const tagRows = (Array.isArray(tags) ? tags : []).slice(0, TAG_LIMIT).map((row) => ({
    id: row.id == null ? null : String(row.id),
    name: String(row.name ?? '').trim() || '标签',
    color: row.color == null ? null : String(row.color),
  }));

  return {
    domain: 'memo',
    recent_count: recent.length,
    recent_memos: recent,
    tags: tagRows,
    note: '备忘只读摘要（标题+id+短预览）；改写/落库需用户确认，助手不写库。',
  };
}
