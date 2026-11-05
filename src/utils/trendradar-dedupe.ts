import { createHash } from 'crypto';
import { normalizeTrendRadarUrl } from './trendradar-url.js';

/**
 * TrendRadar 新闻去重：官方以「规范化 URL + platform」为唯一键。
 * 本库用 url_hash = sha1(normalize_url(url, platformId))；无 URL 时 url_hash 为 null（不参与唯一约束）。
 */

export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * 计算去重用的 url_hash。
 * - 有 URL：sha1(标准化后的 URL)
 * - 无 URL：返回 null（与官方「空 URL 不进唯一索引」一致）
 */
export function computeNewsUrlHash(
  url: string | null | undefined,
  platformId = '',
): string | null {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return null;
  const normalized = normalizeTrendRadarUrl(raw, platformId);
  if (!normalized) return null;
  return sha1Hex(normalized);
}
