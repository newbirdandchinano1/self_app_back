/**
 * TrendRadar URL 标准化（对齐官方 trendradar/utils/url.py）。
 * 用于 url_hash 去重：去掉动态排名/追踪参数，保留核心查询参数。
 */

/** 各平台需移除的特定参数 */
const PLATFORM_PARAMS_TO_REMOVE: Record<string, Set<string>> = {
  // 微博：band_rank / Refer / t 为动态参数，保留 q（关键词）
  weibo: new Set(['band_rank', 'Refer', 't']),
};

/** 通用追踪参数（所有平台） */
const COMMON_TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'referrer',
  'source',
  'channel',
  '_t',
  'timestamp',
  '_',
  'random',
  'share_token',
  'share_id',
  'share_from',
]);

/**
 * 标准化 URL，去除动态参数。
 * @param url 原始 URL
 * @param platformId 平台 ID（如 weibo）；未知时可传空，仍会去掉通用追踪参数
 */
export function normalizeTrendRadarUrl(url: string, platformId = ''): string {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return raw;

  try {
    const parsed = new URL(raw);
    if (![...parsed.searchParams.keys()].length) {
      parsed.hash = '';
      return parsed.toString();
    }

    const paramsToRemove = new Set(
      [...COMMON_TRACKING_PARAMS].map((p) => p.toLowerCase()),
    );
    const pid = platformId.trim().toLowerCase();
    const platformParams = PLATFORM_PARAMS_TO_REMOVE[pid];
    if (platformParams) {
      for (const p of platformParams) paramsToRemove.add(p.toLowerCase());
    }
    // 无 platform_id 时：微博域名也按 weibo 规则处理（webhook 常缺 platform_id）
    if (!pid && /(^|\.)weibo\.com$/i.test(parsed.hostname)) {
      for (const p of PLATFORM_PARAMS_TO_REMOVE.weibo!) {
        paramsToRemove.add(p.toLowerCase());
      }
    }

    const kept: Array<[string, string]> = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      if (paramsToRemove.has(key.toLowerCase())) continue;
      kept.push([key, value]);
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    parsed.search = '';
    parsed.hash = '';
    if (kept.length === 0) return parsed.toString();

    const qs = kept
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    // URL.toString() 在无 search 时不会带 ?；直接拼查询串
    const base = parsed.toString().replace(/\?$/, '');
    return `${base}?${qs}`;
  } catch {
    return raw;
  }
}
