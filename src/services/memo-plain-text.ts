/**
 * 备忘录 AI / 预览用纯文本抽取（与客户端 plainTextFromBody 语义对齐）。
 * 权威 RichDoc 只抽可见文本；旧 markup 原样返回；禁止把 JSON 键名喂给模型。
 */

type RunLike = { text?: unknown };
type BlockLike = {
  type?: unknown;
  runs?: RunLike[];
  items?: Array<{ runs?: RunLike[] }>;
  text?: unknown;
};

function runsText(runs: RunLike[] | undefined): string {
  if (!Array.isArray(runs)) return '';
  return runs.map((r) => (typeof r.text === 'string' ? r.text : '')).join('');
}

/** 从已解析的 RichDoc blocks 抽纯文本（镜像客户端 plainTextFromRichDoc） */
export function plainTextFromRichDocBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const raw of blocks) {
    const b = (raw ?? {}) as BlockLike;
    switch (b.type) {
      case 'paragraph':
      case 'heading':
      case 'quote':
      case 'todo':
        parts.push(runsText(b.runs));
        break;
      case 'bullet_list':
      case 'ordered_list':
        if (Array.isArray(b.items)) {
          for (const it of b.items) parts.push(runsText(it?.runs));
        }
        break;
      case 'code':
        if (typeof b.text === 'string') parts.push(b.text);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'divider':
        break;
      default:
        // 未知 type：尽量抽 runs，避免整段 JSON 泄漏
        if (Array.isArray(b.runs)) parts.push(runsText(b.runs));
        else if (typeof b.text === 'string') parts.push(b.text);
        break;
    }
  }
  return parts.join('\n');
}

/**
 * body 字符串 → AI/搜索用纯文本。
 * - RichDoc：只抽可见文本
 * - 旧 markup / 非 RichDoc：原样返回
 */
export function plainTextFromMemoBody(body: string): string {
  if (typeof body !== 'string') return '';
  const t = body.trimStart();
  if (t[0] !== '{') return body;

  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return body;
  }

  const r = (o ?? {}) as Record<string, unknown>;
  if (r.format !== 'selfapp-richdoc') return body;

  const doc = r.doc;
  if (!doc || typeof doc !== 'object') return '';
  const blocks = (doc as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return '';
  return plainTextFromRichDocBlocks(blocks);
}
