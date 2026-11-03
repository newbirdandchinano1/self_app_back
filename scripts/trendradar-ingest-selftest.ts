/**
 * TrendRadar webhook Markdown 解析自测（手动运行: npx tsx scripts/trendradar-ingest-selftest.ts）
 * 纯解析、不连数据库。可用 TRENDRADAR_SAMPLE_DIR 指向真实抓包目录做补充校验。
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  parseTrendRadarMarkdown,
  shanghaiToUtcMysql,
  type ParsedTrendRadar,
} from '../src/services/trendradar.js';

const FIXTURE = `**[第 1/4 批次]**

**总新闻：** 49 条（新增 2 + 0）
**热榜：** 41/254（平台 11/11）
**RSS：** 8/20（源 1/2）

**类型：** 当前榜单
**时间：** 2026-11-04 02:26:41
**最热话题：** 北美(9) | 中国(6) | 影之刃零(5)

📊 **热点词汇统计** (共 41 条)

📈 [1/15] **北美** : **9** 条

  1. [澎湃新闻] [褶皱里的民意](https://m.thepaper.cn/newsDetail_forward_34386844) **[3]** - [01:50 ~ 02:26] (3次)

  2. [华尔街见闻] [美股小幅反弹](https://wallstreetcn.com/articles/3785045) **[4 - 5]** 📈 - [01:50 ~ 02:26] (3次)

  9. [华尔街见闻] 🆕 [伊朗拒绝开放霍尔木兹](https://wallstreetcn.com/articles/3785095) [10] - 02:26

📌 [7/15] **东亚** : 2 条

  1. [凤凰网] [上万日本民众集会](https://original.ifeng.com/c/8xkz4fVOkLp) **[3]** - [01:50 ~ 02:26] (3次)

📰 **RSS 订阅统计** (共 8 条)

📌 [5/5] **AI 相关** : 1 条

  1. [Hacker News] [Postman silently auto-installs AI plugins](https://github.com/postmanlabs/postman-app-support/issues/14370) **[4]** - 11-04 01:22

> 更新时间：2026-11-04 02:26:41
`;

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.error(`  ✗ ${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function runFixture(): void {
  console.log('[fixture] 解析内置样例');
  const p = parseTrendRadarMarkdown(FIXTURE, '当前榜单');
  check('mode', p.mode, 'current');
  check('modeLabel', p.modeLabel, '当前榜单');
  check('reportTimeLocal', p.reportTimeLocal, '2026-11-04 02:26:41');
  check('batch', [p.batchIndex, p.batchTotal], [1, 4]);
  check('totalNews/newNews', [p.totalNews, p.newNews], [49, 2]);
  check('hotlist', [p.hotlistMatched, p.hotlistTotal, p.platformOk, p.platformTotal], [41, 254, 11, 11]);
  check('rss', [p.rssMatched, p.rssTotal, p.rssSourceOk, p.rssSourceTotal], [8, 20, 1, 2]);
  check('topTopics', p.topTopics, '北美(9) | 中国(6) | 影之刃零(5)');
  check('items.length', p.items.length, 5);

  const first = p.items[0]!;
  check('item1.group', [first.keywordGroup, first.groupSeq, first.groupTotal, first.groupCount], ['北美', 1, 15, 9]);
  check('item1.platform', first.platformName, '澎湃新闻');
  check('item1.title', first.title, '褶皱里的民意');
  check('item1.url', first.url, 'https://m.thepaper.cn/newsDetail_forward_34386844');
  check('item1.rank', [first.rankNo, first.rankEnd], [3, null]);
  check('item1.appear/count', [first.appearTime, first.crawlCount], ['01:50 ~ 02:26', 3]);
  check('item1.isNew', first.isNew, false);

  const ranged = p.items[1]!;
  check('item2.rank range + trend', [ranged.rankNo, ranged.rankEnd, ranged.rankTrend], [4, 5, 'up']);

  const fresh = p.items[2]!;
  check('item3.isNew + time', [fresh.isNew, fresh.appearTime, fresh.seqNo], [true, '02:26', 9]);

  const rss = p.items[4]!;
  check('rss item section/group', [rss.section, rss.keywordGroup], ['rss', 'AI 相关']);
  check('rss item appearTime', rss.appearTime, '11-04 01:22');

  check('time→utc', shanghaiToUtcMysql('2026-11-04 02:26:41'), '2026-11-03 18:26:41');
}

function runSamples(): void {
  const dir = process.env.TRENDRADAR_SAMPLE_DIR;
  if (!dir) return;
  console.log(`[samples] ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  let totalItems = 0;
  for (const file of files) {
    const payload = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      title?: string;
      content?: string;
    };
    const p: ParsedTrendRadar = parseTrendRadarMarkdown(payload.content ?? '', payload.title ?? '');
    totalItems += p.items.length;
    if (!p.modeLabel) {
      failed += 1;
      console.error(`  ✗ ${file} 未解析出类型`);
    }
    console.log(
      `  - ${file}: batch=${p.batchIndex}/${p.batchTotal} items=${p.items.length} mode=${p.modeLabel} time=${p.reportTimeLocal}`,
    );
  }
  check('samples.totalItems > 0', totalItems > 0, true);
}

runFixture();
runSamples();

if (failed > 0) {
  console.error(`\n[FAIL] ${failed} 个断言未通过`);
  process.exit(1);
}
console.log('\n[OK] 全部断言通过');