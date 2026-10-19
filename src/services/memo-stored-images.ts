import type { RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  bindStoredImage,
  deleteStoredImage,
  listStoredImages,
  StoredImageError,
} from './stored-images.js';

const STORED_IMAGE_URI_RE = /^\/uploads\/images\/([0-9a-f-]{36})\.[a-z0-9]+$/i;

/** 正文里的统一库路径。RichDoc 图片块和旧 markup `![img](uri)` 都认。 */
export function collectMemoStoredImageUris(body: string): string[] {
  if (typeof body !== 'string' || !body) return [];
  const found = new Set<string>();
  const trimmed = body.trimStart();
  if (trimmed[0] === '{') {
    try {
      const parsed = JSON.parse(body) as { format?: unknown; doc?: { blocks?: unknown } };
      if (parsed.format === 'selfapp-richdoc' && Array.isArray(parsed.doc?.blocks)) {
        for (const raw of parsed.doc.blocks) {
          const block = (raw ?? {}) as { type?: unknown; uri?: unknown };
          if (block.type !== 'image' || typeof block.uri !== 'string') continue;
          const uri = block.uri.trim();
          if (STORED_IMAGE_URI_RE.test(uri)) found.add(uri);
        }
        return [...found];
      }
    } catch {
      /* 落到旧 markup */
    }
  }
  const re = /!\[img\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const uri = match[1]!.trim();
    if (STORED_IMAGE_URI_RE.test(uri)) found.add(uri);
  }
  return [...found];
}

export async function readMemoBody(memoId: string): Promise<string> {
  const id = memoId.trim();
  if (!id) return '';
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT body FROM memos WHERE id = ? LIMIT 1`,
    [id],
  );
  const body = rows[0]?.body;
  return typeof body === 'string' ? body : '';
}

/**
 * 让 `stored_images` 和备忘正文一致。
 * 正文里新出现的 `/uploads/images/` 绑到 `memos.body`；从正文消失的，以及已绑定但正文不再引用的，删登记和文件。
 * 失败只打日志，不打断备忘保存。
 */
export async function syncMemoStoredImages(
  memoId: string,
  previousBody: string,
  nextBody: string,
): Promise<void> {
  const id = memoId.trim();
  if (!id) return;
  const previous = new Set(collectMemoStoredImageUris(previousBody));
  const next = new Set(collectMemoStoredImageUris(nextBody));

  for (const uri of previous) {
    if (!next.has(uri)) await removeStoredMemoImage({ uri });
  }

  try {
    const owned = await listStoredImages({ owner_table: 'memos', owner_id: id });
    for (const row of owned) {
      if (!next.has(row.uri)) await removeStoredMemoImage({ id: row.id });
    }
  } catch (err) {
    console.error('[memo-images] 查询绑定图片失败', id, err);
  }

  for (const uri of next) {
    const imageId = uri.match(STORED_IMAGE_URI_RE)?.[1];
    if (!imageId) continue;
    try {
      await bindStoredImage({
        id: imageId,
        purpose: 'memo',
        owner_table: 'memos',
        owner_id: id,
        owner_field: 'body',
      });
    } catch (err) {
      if (err instanceof StoredImageError && err.status === 404) continue;
      console.error('[memo-images] 绑定失败', imageId, err);
    }
  }
}

async function removeStoredMemoImage(input: { id?: string; uri?: string }): Promise<void> {
  try {
    await deleteStoredImage(input);
  } catch (err) {
    if (err instanceof StoredImageError && err.status === 404) return;
    console.error('[memo-images] 删除失败', input, err);
  }
}
