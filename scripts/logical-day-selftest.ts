/**
 * 逻辑日 / 时区自测（手动运行: npx tsx scripts/logical-day-selftest.ts）
 */
import '../src/bootstrap/timezone.js';
import {
  getLogicalYmdFromCreatedAt,
  formatDbDateTimeForApi,
  formatRecordDateTimesForApi,
} from '../src/services/calendar/logical-day.js';
import { resolveHeatmapEventCreatedAtBounds } from '../src/services/pages/heatmap-range.js';
import { filterNetCompletedEvents } from '../src/services/pages/task-net-completion.js';

type Case = {
  name: string;
  createdAt: unknown;
  boundary: { hour: number; minute: number };
  expectLogicalYmd: string;
};

const boundary0 = { hour: 0, minute: 0 };
const boundary4 = { hour: 4, minute: 0 };

const cases: Case[] = [
  {
    name: '无时区 DATETIME 晚上 23:00 仍属当天',
    createdAt: '2026-08-18 23:00:00',
    boundary: boundary0,
    expectLogicalYmd: '2026-08-18',
  },
  {
    name: 'API 把墙上时钟格式化成 ISO Z 后仍按数字取当天',
    createdAt: '2026-08-18T23:00:00.000Z',
    boundary: boundary0,
    expectLogicalYmd: '2026-08-18',
  },
  {
    name: '无时区 DATETIME 6/26 01:00 属 6/26',
    createdAt: '2026-06-26 01:00:00',
    boundary: boundary0,
    expectLogicalYmd: '2026-06-26',
  },
  {
    name: '无时区 DATETIME 6/29 16:00 属 6/29（不再当 UTC 加 8 小时）',
    createdAt: '2026-06-29 16:00:00',
    boundary: boundary0,
    expectLogicalYmd: '2026-06-29',
  },
  {
    name: '日界 4:00 — 墙上时钟 6/26 02:00 属逻辑 6/25',
    createdAt: '2026-06-26 02:00:00',
    boundary: boundary4,
    expectLogicalYmd: '2026-06-25',
  },
  {
    name: '日界 4:00 — 墙上时钟 6/26 10:00 属逻辑 6/26',
    createdAt: '2026-06-26 10:00:00',
    boundary: boundary4,
    expectLogicalYmd: '2026-06-26',
  },
];

let passed = 0;
let failed = 0;

console.log(`进程 TZ: ${process.env.TZ ?? '(未设置)'}\n`);
console.log('=== 待办 created_at → 逻辑日（墙上时钟，不加 UTC 偏移）===\n');

for (const c of cases) {
  const got = getLogicalYmdFromCreatedAt(c.createdAt, c.boundary);
  const ok = got === c.expectLogicalYmd;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`  输入: ${String(c.createdAt)}`);
  console.log(`  期望: ${c.expectLogicalYmd}  实际: ${got ?? '(null)'}`);
  console.log('');
}

console.log('=== SQL 查询边界（逻辑日 6/26，日界 0:00，墙上时钟）===\n');
const bounds = resolveHeatmapEventCreatedAtBounds('2026-06-26', '2026-06-26', boundary0);
console.log(`created_at >= ${bounds.createdAtGte}`);
console.log(`created_at <= ${bounds.createdAtLte}`);
const boundsOk =
  bounds.createdAtGte === '2026-06-26 00:00:00' && bounds.createdAtLte === '2026-06-26 23:59:59';
console.log(boundsOk ? '✓ 边界为墙上时钟当天 00:00:00～23:59:59' : '✗ 边界异常');
if (boundsOk) passed += 1;
else failed += 1;

console.log('\n=== 非重复待办净完成：完成→撤销→再完成只计最后一天 ===\n');
const net = filterNetCompletedEvents(
  [
    {
      task_id: 't1',
      action: 'completed',
      created_at: '2026-08-17 21:00:00',
      logicalYmd: '2026-08-17',
    },
    {
      task_id: 't1',
      action: 'reopened',
      created_at: '2026-08-18 09:00:00',
      logicalYmd: '2026-08-18',
    },
    {
      task_id: 't1',
      action: 'completed',
      created_at: '2026-08-18 22:00:00',
      logicalYmd: '2026-08-18',
    },
  ],
  new Set(),
);
const netOk = net.length === 1 && net[0]?.logicalYmd === '2026-08-18';
console.log(netOk ? '✓ 只保留再完成当天' : `✗ 实际 ${JSON.stringify(net)}`);
if (netOk) passed += 1;
else failed += 1;

console.log('\n=== API 响应：DB UTC → ISO Z ===\n');
const apiCases = [
  { db: '2026-06-29 16:00:00', expect: '2026-06-29T16:00:00.000Z', mode: 'utc' as const },
  { db: '2026-06-30 06:00:00', expect: '2026-06-30T06:00:00.000Z', mode: 'utc' as const },
];
for (const c of apiCases) {
  const got = formatDbDateTimeForApi(c.db, c.mode);
  const ok = got === c.expect;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '✓' : '✗'} [${c.mode}] ${c.db} → ${got ?? '(null)'}`);
  if (!ok) console.log(`  期望: ${c.expect}`);
}
console.log('');

console.log('=== API 响应：health_records 东八区墙钟 → ISO Z ===\n');
const healthCases = [
  {
    name: 'created_at 东八区 6/30 10:00',
    row: { created_at: '2026-06-30 10:00:00', record_date: '2026-06-30' },
    expectCreatedAt: '2026-06-30T02:00:00.000Z',
    expectRecordDate: '2026-06-30',
  },
  {
    name: 'record_date 含具体时刻',
    row: { created_at: '2026-06-30 10:00:00', record_date: '2026-06-30 10:00:00' },
    expectCreatedAt: '2026-06-30T02:00:00.000Z',
    expectRecordDate: '2026-06-30T02:00:00.000Z',
  },
];
for (const c of healthCases) {
  const got = formatRecordDateTimesForApi(c.row, 'health_records');
  const ok =
    got.created_at === c.expectCreatedAt && got.record_date === c.expectRecordDate;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  if (!ok) {
    console.log(`  created_at: ${String(got.created_at)} (期望 ${c.expectCreatedAt})`);
    console.log(`  record_date: ${String(got.record_date)} (期望 ${c.expectRecordDate})`);
  }
}
console.log('');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
