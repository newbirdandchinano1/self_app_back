/**
 * P0 专用写接口自测（连库）
 * 运行：npx tsx scripts/dedicated-write-selftest.ts
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import { db } from '../src/db/index.js';
import {
  createWishBoardItem,
  deleteWishBoardItem,
  updateWishBoardItem,
  WishBoardError,
} from '../src/services/wish-board.js';
import {
  createIntake,
  deleteIntake,
  updateIntake,
  HealthError,
} from '../src/services/health.js';
import {
  createFinanceTransaction,
  deleteFinanceTransaction,
  updateFinanceTransaction,
  FinanceTxnError,
} from '../src/services/finance-transactions.js';
import {
  formatGenericWriteForbiddenMessage,
  isGenericWriteForbidden,
} from '../src/config/tables.js';

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

async function ensureTestAccount(): Promise<string> {
  const id = `ft_acct_selftest_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await db.query(
    `INSERT INTO finance_accounts
       (id, name, account_type, sign_rule, note, created_at, updated_at, sync_status)
     VALUES (?, '自测资产账户', 'asset', 1, NULL, ?, ?, 'synced')`,
    [id, now, now],
  );
  return id;
}

async function cleanupAccount(accountId: string): Promise<void> {
  await db.query(`DELETE FROM finance_transactions WHERE account_id = ?`, [accountId]);
  await db.query(`DELETE FROM finance_accounts WHERE id = ?`, [accountId]);
}

async function main() {
  console.log('=== 配置：高危表禁写提示 ===\n');
  check('points_ledger 禁写', isGenericWriteForbidden('points_ledger'));
  check('finance_transactions 禁写', isGenericWriteForbidden('finance_transactions'));
  check(
    '提示含专用端点',
    formatGenericWriteForbiddenMessage('health_records').includes('/health/intakes'),
  );

  console.log('\n=== 心愿板 updateWishBoardItem ===\n');
  const wishId = `wb_selftest_${randomUUID().slice(0, 8)}`;
  try {
    const created = await createWishBoardItem({
      id: wishId,
      title: '自测心愿',
      cost_points: 10,
      wish_type: 'once',
    });
    check('创建心愿', created.id === wishId && created.title === '自测心愿');

    const updated = await updateWishBoardItem(wishId, {
      title: '自测心愿已改',
      cost_points: 12.5,
    });
    check('更新标题与积分', updated.title === '自测心愿已改' && updated.cost_points === 12.5);

    let blocked = false;
    try {
      await updateWishBoardItem('missing_' + wishId, { title: 'x' });
    } catch (e) {
      blocked = e instanceof WishBoardError && e.status === 404;
    }
    check('更新不存在心愿 → 404', blocked);
  } finally {
    try {
      await deleteWishBoardItem(wishId);
      check('删除心愿', true);
    } catch {
      check('删除心愿', false);
    }
  }

  console.log('\n=== 健康摄入 update/delete ===\n');
  const intakeId = `hi_selftest_${randomUUID().slice(0, 8)}`;
  try {
    const created = await createIntake({
      id: intakeId,
      hydration: 200,
      protein: 10,
      calories: 100,
      record_date: '2026-09-26',
      intake_display_title: '自测餐',
    });
    check('创建摄入', created.id === intakeId);

    const updated = await updateIntake(intakeId, {
      hydration: 350,
      intake_display_title: '自测餐改',
    });
    check(
      '更新摄入',
      Number(updated.hydration) === 350 && updated.intake_display_title === '自测餐改',
    );

    const del = await deleteIntake(intakeId);
    check('删除摄入', del.deleted === true);

    let missing = false;
    try {
      await updateIntake(intakeId, { hydration: 1 });
    } catch (e) {
      missing = e instanceof HealthError && e.status === 404;
    }
    check('更新已删记录 → 404', missing);
  } catch (e) {
    check('健康摄入流程', false, e instanceof Error ? e.message : String(e));
    try {
      await deleteIntake(intakeId);
    } catch {
      /* ignore */
    }
  }

  console.log('\n=== 财务流水 create/update/delete ===\n');
  let accountId = '';
  const txnId = `ftxn_selftest_${randomUUID().slice(0, 8)}`;
  try {
    accountId = await ensureTestAccount();

    // 先入账，避免支出把余额打负
    const income = await createFinanceTransaction({
      id: `${txnId}_in`,
      name: '自测收入',
      account_id: accountId,
      amount: 100,
      transaction_type: 'income',
      happened_at: '2026-09-26 10:00:00',
    });
    check('创建收入流水', Number(income.amount) === 100);

    const expense = await createFinanceTransaction({
      id: txnId,
      name: '自测支出',
      account_id: accountId,
      amount: 30,
      transaction_type: 'expense',
      happened_at: '2026-09-26 12:00:00',
    });
    check('创建支出流水', Number(expense.amount) === 30);

    const updated = await updateFinanceTransaction(txnId, {
      name: '自测支出改',
      amount: 25,
    });
    check('更新支出', updated.name === '自测支出改' && Number(updated.amount) === 25);

    let overdrawBlocked = false;
    try {
      await createFinanceTransaction({
        id: `${txnId}_over`,
        name: '超额支出',
        account_id: accountId,
        amount: 99999,
        transaction_type: 'expense',
        happened_at: '2026-09-26 13:00:00',
      });
    } catch (e) {
      overdrawBlocked = e instanceof FinanceTxnError;
    }
    check('超额支出被拒', overdrawBlocked);

    const del = await deleteFinanceTransaction(txnId);
    check('删除支出', del.deleted === true);

    await deleteFinanceTransaction(`${txnId}_in`);
    check('删除收入', true);

    let genericHint = false;
    try {
      // 模拟通用 CRUD 禁写配置仍生效
      genericHint = isGenericWriteForbidden('finance_transactions');
    } catch {
      genericHint = false;
    }
    check('finance 仍在通用写黑名单', genericHint);
  } catch (e) {
    check('财务流水流程', false, e instanceof Error ? e.message : String(e));
  } finally {
    if (accountId) await cleanupAccount(accountId);
  }

  console.log(`\n=== 结果：${passed} passed / ${failed} failed ===`);
  try {
    await db.end();
  } catch {
    /* ignore */
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
