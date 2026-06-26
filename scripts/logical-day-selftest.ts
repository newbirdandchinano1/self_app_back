/**
 * 逻辑日 / 时区自测（手动运行: npx tsx scripts/logical-day-selftest.ts）
 */
import '../src/bootstrap/timezone.js';
import {
  getLogicalYmdFromCreatedAt,
  getWallClockInAppTimeZone,
  parseDbDateTimeToInstant,
} from '../src/services/calendar/logical-day.js';
import { resolveHeatmapEventCreatedAtBounds } from '../src/services/pages/heatmap-range.js';

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
    name: 'MySQL 东八区墙钟 6/26 01:00（全局 TZ 下的标准存法）',
    createdAt: '2026-06-26 01:00:00',
    boundary: boundary0,
    expectLogicalYmd: '2026-06-26',
  },
  {
    name: 'MySQL 东八区墙钟 6/26 14:00',
    createdAt: '2026-06-26 14:00:00',
    boundary: boundary0,
    expectLogicalYmd: '2026-06-26',
  },
  {
    name: 'ISO 带 Z（APP 写 UTC 时刻，仍应归到东八区正确逻辑日）',
    createdAt: '2026-06-25T17:00:00.000Z',
    boundary: boundary0,
    expectLogicalYmd: '2026-06-26',
  },
  {
    name: '日界 4:00 — 东八区 6/26 02:00 属逻辑 6/25',
    createdAt: '2026-06-26 02:00:00',
    boundary: boundary4,
    expectLogicalYmd: '2026-06-25',
  },
  {
    name: '日界 4:00 — 东八区 6/26 10:00 属逻辑 6/26',
    createdAt: '2026-06-26 10:00:00',
    boundary: boundary4,
    expectLogicalYmd: '2026-06-26',
  },
];

let passed = 0;
let failed = 0;

console.log(`进程 TZ: ${process.env.TZ ?? '(未设置)'}\n`);
console.log('=== 待办 created_at → 逻辑日（东八区全局）===\n');

for (const c of cases) {
  const got = getLogicalYmdFromCreatedAt(c.createdAt, c.boundary);
  const ok = got === c.expectLogicalYmd;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`  输入: ${String(c.createdAt)}`);
  console.log(`  期望: ${c.expectLogicalYmd}  实际: ${got ?? '(null)'}`);
  const instant = parseDbDateTimeToInstant(c.createdAt);
  if (instant) {
    const wc = getWallClockInAppTimeZone(instant);
    console.log(
      `  东八区墙钟: ${wc.year}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')} ${String(wc.hour).padStart(2, '0')}:${String(wc.minute).padStart(2, '0')}`,
    );
  }
  console.log('');
}

console.log('=== 青蛙 assigned_ymd（纯字符串，无时区）===\n');
console.log("assigned_ymd = '2026-06-26' → 格子 2026-06-26\n");

console.log('=== SQL 查询边界（逻辑日 6/26，日界 0:00，东八区 DATETIME）===\n');
const bounds = resolveHeatmapEventCreatedAtBounds('2026-06-26', '2026-06-26', boundary0);
console.log(`created_at >= ${bounds.createdAtGte}`);
console.log(`created_at <= ${bounds.createdAtLte}`);
const boundsOk =
  bounds.createdAtGte === '2026-06-26 00:00:00' && bounds.createdAtLte === '2026-06-26 23:59:59';
console.log(boundsOk ? '✓ 边界为东八区自然日' : '✗ 边界异常');
if (boundsOk) passed += 1;
else failed += 1;

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
