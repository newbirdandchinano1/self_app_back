/**
 * 财务页专用接口口径自测（不连库）
 * 运行：npx tsx scripts/finance-page-selftest.ts
 */
import '../src/bootstrap/timezone.js';
import {
  budgetCycleStart,
  clampBudgetRefreshDay,
  computeTransactionLedgerEffect,
  isBalanceCorrection,
  isInitialBalanceFinanceTransaction,
  listMonthKeysBetween,
  listMonthKeysEndingAt,
  logicalYmdFromHappenedAt,
  previousBudgetCycleStart,
  resolveFinanceHomeWindow,
  resolveFinanceStatsCategory,
  resolveStatsGranularity,
  shouldExcludeFromNetWorth,
  ymdFromParts,
} from '../src/services/pages/finance.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('=== 余额口径 computeTransactionLedgerEffect ===\n');

check('income 取绝对值加', computeTransactionLedgerEffect('income', -100) === 100);
check('expense 取绝对值减', computeTransactionLedgerEffect('expense', 50) === -50);
check(
  'transfer_leg=in 加',
  computeTransactionLedgerEffect('transfer', 20, JSON.stringify({ transfer_leg: 'in' })) === 20,
);
check(
  'transfer_leg=out 减',
  computeTransactionLedgerEffect('transfer', 20, JSON.stringify({ transfer_leg: 'out' })) === -20,
);
check('transfer 缺省按 out', computeTransactionLedgerEffect('transfer', 20, '{}') === -20);
check(
  'transferLeg camelCase',
  computeTransactionLedgerEffect('transfer', 8, JSON.stringify({ transferLeg: 'in' })) === 8,
);

console.log('\n=== extra_data 标志 ===\n');

check(
  'exclude_from_total_assets',
  shouldExcludeFromNetWorth({ exclude_from_total_assets: true }),
);
check(
  'excludeFromTotalAssets camelCase',
  shouldExcludeFromNetWorth({ excludeFromTotalAssets: true }),
);
check('未排除计入净资产', shouldExcludeFromNetWorth({}) === false);
check(
  'balance_correction kind',
  isBalanceCorrection({ kind: 'balance_correction' }),
);
check('普通流水不是校正', isBalanceCorrection({ kind: 'note' }, 'expense') === false);

console.log('\n=== 预算周期 ===\n');

check(
  '刷新日=1，月中 → 本月 1 号',
  budgetCycleStart('2026-08-19', 1) === '2026-08-01',
);
check(
  '刷新日=25，今天 19 号 → 上月 25',
  budgetCycleStart('2026-08-19', 25) === '2026-07-25',
);
check(
  '刷新日=25，今天 25 号 → 本月 25',
  budgetCycleStart('2026-08-25', 25) === '2026-08-25',
);
check(
  '刷新日=31，2 月钳到月末',
  budgetCycleStart('2026-02-10', 31) === '2026-01-31',
);
check('2 月 31 日钳到 28（非闰年）', ymdFromParts(2026, 2, 31) === '2026-02-28');
check('2024 闰年 2 月 31 → 29', ymdFromParts(2024, 2, 31) === '2024-02-29');
check(
  '上一周期：本周期 2026-08-01 → 2026-07-01',
  previousBudgetCycleStart('2026-08-01', 1) === '2026-07-01',
);
check(
  '上一周期跨年：2026-01-01 → 2025-12-01',
  previousBudgetCycleStart('2026-01-01', 1) === '2025-12-01',
);
check('budgetRefreshDay 钳到 1–31', clampBudgetRefreshDay(0) === 1 && clampBudgetRefreshDay(99) === 31);

console.log('\n=== home 流水窗口 ===\n');

const wide = resolveFinanceHomeWindow({
  logicalToday: '2026-08-19',
  daysBack: 90,
  budgetRefreshDay: 1,
});
check(
  'daysBack=90 覆盖两预算周期',
  wide.windowStart === '2026-05-21' && wide.previousCycleStart === '2026-07-01',
  JSON.stringify(wide),
);

const tight = resolveFinanceHomeWindow({
  logicalToday: '2026-08-19',
  daysBack: 10,
  budgetRefreshDay: 1,
});
check(
  'daysBack 短于两周期时取周期起点',
  tight.windowStart === '2026-07-01' && tight.daysBackStart === '2026-08-09',
  JSON.stringify(tight),
);

const refresh25 = resolveFinanceHomeWindow({
  logicalToday: '2026-08-19',
  daysBack: 10,
  budgetRefreshDay: 25,
});
check(
  '刷新日 25：窗口从上一周期 6/25 起',
  refresh25.windowStart === '2026-06-25' && refresh25.currentCycleStart === '2026-07-25',
  JSON.stringify(refresh25),
);

console.log('\n=== 逻辑日（墙上时钟，禁止当 UTC） ===\n');

const boundary0 = { hour: 0, minute: 0 };
const boundary4 = { hour: 4, minute: 0 };
check(
  '无时区 DATETIME 直接取日历日',
  logicalYmdFromHappenedAt('2026-08-19 03:00:00', boundary0) === '2026-08-19',
);
check(
  '带 Z 仍按墙上数字，不加 8 小时',
  logicalYmdFromHappenedAt('2026-08-19 03:00:00Z', boundary0) === '2026-08-19',
);
check(
  '日界 4:00：03:59 算前一天',
  logicalYmdFromHappenedAt('2026-08-19 03:59:00', boundary4) === '2026-08-18',
);
check(
  '日界 4:00：04:00 算当天',
  logicalYmdFromHappenedAt('2026-08-19 04:00:00', boundary4) === '2026-08-19',
);

console.log('\n=== 洞察月份键 ===\n');

check(
  '6 个月含当月，升序',
  listMonthKeysEndingAt('2026-08-19', 6).join(',') === '2026-03,2026-04,2026-05,2026-06,2026-07,2026-08',
);
check(
  '跨年 3 个月',
  listMonthKeysEndingAt('2026-01-05', 3).join(',') === '2025-11,2025-12,2026-01',
);

console.log('\n=== 统计页口径 helpers ===\n');

check(
  'reason=balance_correction 视为校正',
  isBalanceCorrection({ reason: 'balance_correction' }, 'expense'),
);
check(
  '初始余额：名称',
  isInitialBalanceFinanceTransaction('初始余额', '{}'),
);
check(
  '初始余额：reason',
  isInitialBalanceFinanceTransaction('开户', JSON.stringify({ reason: 'initial_balance' })),
);
check(
  '非初始余额',
  isInitialBalanceFinanceTransaction('午饭', '{}') === false,
);
check(
  'granularity auto：91 天用月',
  resolveStatsGranularity('auto', '2026-01-01', '2026-04-01') === 'month',
);
check(
  'granularity auto：短区间用日',
  resolveStatsGranularity('auto', '2026-08-01', '2026-08-31') === 'day',
);
check(
  'granularity auto：跨年用月',
  resolveStatsGranularity('auto', '2025-12-20', '2026-01-10') === 'month',
);
check(
  '月份键连续补齐跨年',
  listMonthKeysBetween('2025-11-15', '2026-02-03').join(',') === '2025-11,2025-12,2026-01,2026-02',
);

const catById = new Map([
  ['c1', { id: 'c1', name: '餐饮', iconKey: 'restaurant' }],
]);
const catByName = new Map([
  ['餐饮', { id: 'c1', name: '餐饮', iconKey: 'restaurant' }],
]);
check(
  '分类：flow_category_id 优先',
  resolveFinanceStatsCategory({ flow_category_id: 'c1', extra_data: null }, catById, catByName)
    .name === '餐饮',
);
check(
  '分类：category_key 映射并用名匹配目录',
  resolveFinanceStatsCategory(
    { flow_category_id: null, extra_data: JSON.stringify({ category_key: 'food' }) },
    catById,
    catByName,
  ).categoryId === 'c1',
);
check(
  '分类：未分类',
  resolveFinanceStatsCategory({ flow_category_id: null, extra_data: null }, catById, catByName)
    .name === '未分类',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
