/**
 * Phase 4 Change Log 自测（连库）
 * 运行：npm run test:sync-phase4
 *
 * 验收：白名单表判定；写 memo / health_intake → sync_change_log 有对应行；
 * 可选：有账户时实测 createFinanceTransaction。
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import type { RowDataPacket } from 'mysql2';
import { db } from '../src/db/index.js';
import { ensureSyncChangeLogTable } from '../src/db/ensure-sync-change-log.js';
import { createFinanceTransaction, deleteFinanceTransaction } from '../src/services/finance-transactions.js';
import { createIntake, deleteIntake } from '../src/services/health.js';
import { createMemo, deleteMemo } from '../src/services/memos.js';
import {
  appendChangeLog,
  isChangeLogTable,
  withSyncTransaction,
} from '../src/services/sync-change-log.js';

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

async function latestLogFor(table: string, pk: string): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, device_id, table_name, record_pk, op, hint, created_at
     FROM sync_change_log
     WHERE table_name = ? AND record_pk = ?
     ORDER BY id DESC LIMIT 1`,
    [table, pk],
  );
  return rows[0] ?? null;
}

async function maxLogId(): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(MAX(id), 0) AS mid FROM sync_change_log`,
  );
  return Number(rows[0]?.mid ?? 0);
}

async function main() {
  console.log('=== Phase 4: dedicated write Change Log ===\n');

  await ensureSyncChangeLogTable();
  check('表 sync_change_log 可用', true);

  console.log('\n--- 白名单 ---\n');
  check('isChangeLogTable(finance_transactions)', isChangeLogTable('finance_transactions'));
  check('isChangeLogTable(memos)', isChangeLogTable('memos'));
  check('isChangeLogTable(health_records)', isChangeLogTable('health_records'));
  check('isChangeLogTable(recipe_items)', isChangeLogTable('recipe_items'));
  check('isChangeLogTable(points_wallet)', isChangeLogTable('points_wallet'));
  check('isChangeLogTable(wish_board_items)', isChangeLogTable('wish_board_items'));
  check('isChangeLogTable(app_settings) === false', !isChangeLogTable('app_settings'));

  const deviceId = `phase4_${randomUUID().slice(0, 8)}`;

  console.log('\n--- 直接 appendChangeLog（白名单表） ---\n');
  const directPk = `phase4_direct_${randomUUID().slice(0, 8)}`;
  const beforeDirect = await maxLogId();
  await withSyncTransaction(async (conn) => {
    await appendChangeLog(conn, [
      {
        tableName: 'finance_transactions',
        recordPk: directPk,
        op: 'upsert',
        deviceId,
      },
    ]);
  });
  const directLog = await latestLogFor('finance_transactions', directPk);
  check(
    '直接 append 写入 log',
    directLog != null &&
      directLog.op === 'upsert' &&
      Number(directLog.id) > beforeDirect &&
      directLog.device_id === deviceId,
  );

  console.log('\n--- memo 写路径 ---\n');
  const memoId = `phase4_memo_${randomUUID().slice(0, 8)}`;
  const memo = await createMemo(
    { id: memoId, title: 'Phase4 Change Log 自测', body: 'selftest' },
    { deviceId },
  );
  check('createMemo 成功', memo != null && String(memo.id) === memoId);
  const memoLog = await latestLogFor('memos', memoId);
  check('memo create → upsert log', memoLog != null && memoLog.op === 'upsert');
  check('memo log.device_id', memoLog?.device_id === deviceId);

  await deleteMemo(memoId, { deviceId });
  const memoDelLog = await latestLogFor('memos', memoId);
  check('memo soft-delete → delete log', memoDelLog != null && memoDelLog.op === 'delete');

  console.log('\n--- health intake 写路径 ---\n');
  const intakeId = `phase4_intake_${randomUUID().slice(0, 8)}`;
  const intake = await createIntake(
    {
      id: intakeId,
      hydration: 100,
      protein: 0,
      calories: 0,
      intake_display_title: 'Phase4 selftest',
    },
    { deviceId },
  );
  check('createIntake 成功', intake != null && String(intake.id) === intakeId);
  const intakeLog = await latestLogFor('health_records', intakeId);
  check('intake create → upsert log', intakeLog != null && intakeLog.op === 'upsert');
  check('intake log.device_id', intakeLog?.device_id === deviceId);

  await deleteIntake(intakeId, { deviceId });
  const intakeDelLog = await latestLogFor('health_records', intakeId);
  check('intake delete → delete log', intakeDelLog != null && intakeDelLog.op === 'delete');

  console.log('\n--- finance_transactions（若有账户） ---\n');
  const [accounts] = await db.query<RowDataPacket[]>(
    `SELECT id, account_type, sign_rule FROM finance_accounts LIMIT 1`,
  );
  if (accounts[0]?.id) {
    const accountId = String(accounts[0].id);
    const signRule = Number(accounts[0].sign_rule ?? 1);
    const isLiability =
      String(accounts[0].account_type ?? '') === 'liability' || signRule < 0;
    const amount = isLiability ? -0.01 : 0.01;
    const txnId = `phase4_txn_${randomUUID().slice(0, 8)}`;
    try {
      const txn = await createFinanceTransaction(
        {
          id: txnId,
          name: 'Phase4 Change Log 自测',
          account_id: accountId,
          amount,
          transaction_type: 'expense',
          skip_balance_check: true,
        },
        { deviceId },
      );
      check('createFinanceTransaction 成功', txn != null && String(txn.id) === txnId);
      const txnLog = await latestLogFor('finance_transactions', txnId);
      check('finance create → upsert log', txnLog != null && txnLog.op === 'upsert');
      check('finance log.device_id', txnLog?.device_id === deviceId);

      await deleteFinanceTransaction(txnId, { deviceId });
      const txnDelLog = await latestLogFor('finance_transactions', txnId);
      check('finance delete → delete log', txnDelLog != null && txnDelLog.op === 'delete');
    } catch (err) {
      check('createFinanceTransaction 成功', false, String((err as Error).message));
    }
  } else {
    console.log('（跳过：无 finance_accounts，仅验证白名单与直接 append）');
  }

  console.log(`\n=== 结果：${passed} passed, ${failed} failed ===`);
  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
