/**
 * 写入 MySQL extra_data（多为 TEXT，上限 65535 字节）前去掉本地截图 / base64。
 * 自动记账会把 data URI 塞进 attachments，旧客户端不瘦身就会 ER_DATA_TOO_LONG。
 */

const DATA_URI_RE = /^data:[^;]+;base64,/i;
const LOCAL_ONLY_URI_RE = /^(file|content|ph|assets-library):\/\//i;
const BASE64_BLOB_RE = /^[A-Za-z0-9+/=\s]{512,}$/;

/** 留余量给 utf8mb4 与 JSON 包装 */
export const MYSQL_TEXT_SAFE_BYTES = 60_000;

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isLikelyBase64Blob(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 200 && BASE64_BLOB_RE.test(trimmed);
}

function shouldStripString(value: string): boolean {
  const t = value.trim();
  if (!t) return false;
  if (DATA_URI_RE.test(t)) return true;
  if (isLikelyBase64Blob(t)) return true;
  if (LOCAL_ONLY_URI_RE.test(t)) return true;
  return false;
}

function slimValue(value: unknown, key?: string): unknown {
  if (value == null) return value;

  if (typeof value === 'string') {
    return shouldStripString(value) ? null : value;
  }

  if (Array.isArray(value)) {
    if (key === 'attachments') {
      return value.map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const row = { ...(item as Record<string, unknown>) };
          if (typeof row.uri === 'string' && shouldStripString(row.uri)) {
            row.uri = null;
            row.stripped = true;
          }
          return slimValue(row);
        }
        return slimValue(item);
      });
    }
    return value.map((item) => slimValue(item));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = slimValue(v, k);
    }
    return out;
  }

  return value;
}

function compactIfStillTooLarge(json: string): string {
  if (utf8ByteLength(json) <= MYSQL_TEXT_SAFE_BYTES) return json;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const src = parsed as Record<string, unknown>;
      const keep: Record<string, unknown> = { _upload_truncated: true };
      for (const key of [
        'category_key',
        'category_label',
        'parse_source',
        'manual',
        'sentence',
        'from_clipboard_screenshot',
        'from_shortcut_intent',
        'from_picker_image',
        'happened_at_from_bill',
        'recognized_happened_at',
        'recognized_payment_account',
        'matched_account_name',
      ]) {
        if (src[key] !== undefined) keep[key] = src[key];
      }
      const compact = JSON.stringify(keep);
      if (utf8ByteLength(compact) <= MYSQL_TEXT_SAFE_BYTES) return compact;
    }
  } catch {
    /* fall through */
  }
  return JSON.stringify({ _upload_truncated: true });
}

/**
 * 把 extra_data 收成可写入 TEXT 的 JSON 字符串；无效 JSON 原样抛给调用方处理。
 */
export function slimExtraDataForMysql(raw: unknown): string | null {
  if (raw == null || raw === '') return null;

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    parsed = JSON.parse(t) as unknown;
  } else if (typeof raw !== 'object') {
    throw new Error('extra_data 无效');
  }

  const slimmed = slimValue(parsed);
  let json: string;
  try {
    json = JSON.stringify(slimmed);
  } catch {
    throw new Error('extra_data 无效');
  }
  return compactIfStillTooLarge(json);
}
