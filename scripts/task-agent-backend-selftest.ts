/**
 * 任务 Agent 补齐后端：无 DB 纯函数自测
 * 运行：npx tsx scripts/task-agent-backend-selftest.ts
 */
import { ymdForWeekday } from '../src/services/pages/frog.js';
import { normalizeTasksDayBoundary } from '../src/services/calendar/logical-day.js';

let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

console.log('\n=== promote / day-boundary / placement helpers ===\n');

check('ymdForWeekday 周一+1 → 周一', ymdForWeekday('2026-11-16', 1) === '2026-11-16');
check('ymdForWeekday 周一+4 → 周四', ymdForWeekday('2026-11-16', 4) === '2026-11-19');
check('ymdForWeekday 周一+7 → 周日', ymdForWeekday('2026-11-16', 7) === '2026-11-22');

const b = normalizeTasksDayBoundary({ hour: 4, minute: 30 });
check('日界 normalize 4:30', b.hour === 4 && b.minute === 30);
const clamp = normalizeTasksDayBoundary({ hour: 99, minute: -1 });
check('日界 clamp hour/minute', clamp.hour === 23 && clamp.minute === 0);

if (failed > 0) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log('\n全部通过\n');
