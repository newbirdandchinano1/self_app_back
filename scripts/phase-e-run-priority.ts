/**
 * 阶段 E：按方案优先顺序跑门禁 + 业务自测 + 模拟压测。
 *
 *   npx tsx scripts/phase-e-run-priority.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const steps = [
  'phase-e-gate-selftest.ts',
  'phase-a-capacity-selftest.ts',
  'phase-b-tasks-page-selftest.ts',
  'phase-c-cache-bootstrap-selftest.ts',
  'tasks-page-selftest.ts',
  'task-tree-filter-selftest.ts',
  'project-list-selftest.ts',
  'logical-day-selftest.ts',
  'phase-e-loadtest.ts',
];

let failed = 0;
for (const file of steps) {
  console.log(`\n######## ${file} ########`);
  const r = spawnSync('npx', ['--yes', 'tsx', path.join(root, file)], {
    stdio: 'inherit',
    env: process.env,
    shell: true,
    cwd: path.join(root, '..'),
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${file} (exit ${r.status})`);
  }
}

if (failed > 0) {
  console.error(`\nphase-e-run-priority: ${failed} step(s) failed`);
  process.exit(1);
}
console.log('\nphase-e-run-priority: ALL PASSED');
