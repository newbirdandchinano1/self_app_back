/**
 * TrendRadar URL 标准化自测：npx tsx scripts/trendradar-url-selftest.ts
 */
import { computeNewsUrlHash } from '../src/utils/trendradar-dedupe.js';
import { normalizeTrendRadarUrl } from '../src/utils/trendradar-url.js';

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) {
    failed += 1;
    console.error(`  ✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

console.log('[normalizeTrendRadarUrl]');
check(
  'weibo 去 band_rank/Refer/t',
  normalizeTrendRadarUrl(
    'https://s.weibo.com/weibo?q=test&t=31&band_rank=6&Refer=top',
    'weibo',
  ),
  'https://s.weibo.com/weibo?q=test',
);
check(
  '无 platform_id 的微博域名仍去动态参数',
  normalizeTrendRadarUrl(
    'https://s.weibo.com/weibo?q=%E6%B5%8B%E8%AF%95&band_rank=1&Refer=top&t=31',
  ),
  'https://s.weibo.com/weibo?q=%E6%B5%8B%E8%AF%95',
);
check(
  '去掉 utm',
  normalizeTrendRadarUrl('https://example.com/page?id=1&utm_source=twitter'),
  'https://example.com/page?id=1',
);
check('空串', normalizeTrendRadarUrl(''), '');

const a = computeNewsUrlHash(
  'https://s.weibo.com/weibo?q=x&band_rank=1&Refer=top',
  'weibo',
);
const b = computeNewsUrlHash('https://s.weibo.com/weibo?q=x', 'weibo');
const c = computeNewsUrlHash('https://s.weibo.com/weibo?q=x&band_rank=9');
check('动态参数不同但 hash 相同 (platform_id)', a === b, true);
check('动态参数不同但 hash 相同 (域名推断)', a === c, true);
check('无 URL → null hash', computeNewsUrlHash(null), null);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log('\n全部通过');
