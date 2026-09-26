/**
 * 财务流水专用写：校验账户存在与账本余额符号约束，禁止经通用 CRUD 绕过。
 */
import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  formatMySQLWallClockDateTime,
  formatRecordDateTimesForApi,
  normalizeDbDateTimeForTableStorage,
} from './calendar/logical-day.js';
import { computeTransactionLedgerEffect } from './pages/finance.js';

export class FinanceTxnError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'FinanceTxnError';
  }
}

const FINANCE_BALANCE_EPS = 1e-4;
const TXN_TYPES = new Set(['expense', 'income', 'transfer']);

export type FinanceTxnRecord = Record<string, unknown>;

export type CreateFinanceTxnInput = {
  id?: unknown;
  name?: unknown;
  happened_at?: unknown;
  account_id?: unknown;
  ai_comment?: unknown;
  transaction_type?: unknown;
  flow_category_id?: unknown;
  amount?: unknown;
  note?: unknown;
  extra_data?: unknown;
  /** 跳过余额符号校验（期初余额校正等） */
  skip_balance_check?: unknown;
};

export type UpdateFinanceTxnInput = CreateFinanceTxnInput;

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeSignRule(signRule: unknown, accountType?: string | null): -1 | 1 {
  if (accountType === 'liability') return -1;
  const n = typeof signRule === 'number' ? signRule : Number(signRule);
  if (n < 0) return -1;
  return 1;
}

function serializeExtraData(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try {
      JSON.parse(t);
      return t;
    } catch {
      throw new FinanceTxnError('extra_data 无效 JSON');
    }
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      throw new FinanceTxnError('extra_data 无效');
    }
  }
  throw new FinanceTxnError('extra_data 无效');
}

function normalizeAmount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n === 0) {
    throw new FinanceTxnError('amount 必须为非零数字');
  }
  return Math.round(n * 100) / 100;
}

function normalizeTxnType(raw: unknown): string {
  const t = asTrimmed(raw || 'expense').toLowerCase();
  if (!TXN_TYPES.has(t)) {
    throw new FinanceTxnError('transaction_type 仅支持 expense / income / transfer');
  }
  return t;
}

function normalizeHappenedAt(raw: unknown): string {
  const text = asTrimmed(raw);
  if (!text) return formatMySQLWallClockDateTime(new Date());
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 12:00:00`;
  const normalized = normalizeDbDateTimeForTableStorage('finance_transactions', text);
  if (!normalized) throw new FinanceTxnError('happened_at 格式无效');
  return normalized;
}

function formatTxn(row: RowDataPacket): FinanceTxnRecord {
  return formatRecordDateTimesForApi(
    {
      id: String(row.id),
      name: String(row.name ?? ''),
      happened_at: row.happened_at == null ? '' : String(row.happened_at),
      account_id: String(row.account_id ?? ''),
      ai_comment: row.ai_comment == null ? null : String(row.ai_comment),
      transaction_type: String(row.transaction_type ?? 'expense'),
      flow_category_id: row.flow_category_id == null ? null : String(row.flow_category_id),
      amount: Number(row.amount ?? 0),
      note: row.note == null ? null : String(row.note),
      created_at: row.created_at == null ? '' : String(row.created_at),
      updated_at: row.updated_at == null ? '' : String(row.updated_at),
      sync_status: row.sync_status == null ? 'synced' : String(row.sync_status),
      extra_data: row.extra_data ?? null,
    },
    'finance_transactions',
  );
}

const TXN_SELECT = `SELECT id, name, happened_at, account_id, ai_comment, transaction_type,
        flow_category_id, amount, note, created_at, updated_at, sync_status, extra_data
     FROM finance_transactions`;

export async function getFinanceTransaction(id: string): Promise<FinanceTxnRecord | null> {
  const trimmed = asTrimmed(id);
  if (!trimmed) return null;
  const [rows] = await db.query<RowDataPacket[]>(`${TXN_SELECT} WHERE id = ? LIMIT 1`, [trimmed]);
  return rows[0] ? formatTxn(rows[0]) : null;
}

async function loadAccount(accountId: string): Promise<{
  id: string;
  name: string;
  account_type: string;
  sign_rule: number;
}> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, account_type, sign_rule FROM finance_accounts WHERE id = ? LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) throw new FinanceTxnError('账户不存在', 400);
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    account_type: String(row.account_type ?? 'asset'),
    sign_rule: Number(row.sign_rule ?? 1),
  };
}

async function assertFlowCategoryExists(flowCategoryId: string | null): Promise<void> {
  if (!flowCategoryId) return;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT 1 FROM finance_flow_categories WHERE id = ? LIMIT 1`,
    [flowCategoryId],
  );
  if (rows.length === 0) {
    throw new FinanceTxnError('流水分类不存在', 400);
  }
}

/** 账户账本余额 = 全部流水 ledger effect 之和 */
async function computeAccountLedgerBalance(accountId: string, excludeTxnId?: string): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    excludeTxnId
      ? `SELECT transaction_type, amount, extra_data FROM finance_transactions
         WHERE account_id = ? AND id != ?`
      : `SELECT transaction_type, amount, extra_data FROM finance_transactions WHERE account_id = ?`,
    excludeTxnId ? [accountId, excludeTxnId] : [accountId],
  );
  let sum = 0;
  for (const row of rows) {
    sum += computeTransactionLedgerEffect(row.transaction_type, row.amount, row.extra_data);
  }
  return Math.round(sum * 100) / 100;
}

function assertBalanceWithinSignRule(
  signRule: -1 | 1,
  balanceAfter: number,
  accountName: string,
): void {
  if (signRule > 0 && balanceAfter < -FINANCE_BALANCE_EPS) {
    throw new FinanceTxnError(
      `「${accountName}」余额不能为负数（变更后约 ¥${balanceAfter.toFixed(2)}）`,
    );
  }
  if (signRule < 0 && balanceAfter > FINANCE_BALANCE_EPS) {
    throw new FinanceTxnError(
      `「${accountName}」为负债类账户，余额不能为正数（变更后约 ¥${balanceAfter.toFixed(2)}）`,
    );
  }
}

function assertAmountSignForAccount(
  signRule: -1 | 1,
  amount: number,
): void {
  if (signRule > 0 && amount < 0) {
    throw new FinanceTxnError('资产类账户金额须为正数');
  }
  if (signRule < 0 && amount > 0) {
    throw new FinanceTxnError('负债类账户金额须为负数');
  }
}

async function assertBalanceAfterChange(params: {
  accountId: string;
  accountName: string;
  signRule: -1 | 1;
  delta: number;
  excludeTxnId?: string;
  skip?: boolean;
}): Promise<void> {
  if (params.skip) return;
  const current = await computeAccountLedgerBalance(params.accountId, params.excludeTxnId);
  assertBalanceWithinSignRule(params.signRule, current + params.delta, params.accountName);
}

export async function createFinanceTransaction(
  input: CreateFinanceTxnInput,
): Promise<FinanceTxnRecord> {
  const accountId = asTrimmed(input.account_id);
  if (!accountId) throw new FinanceTxnError('account_id 必填');

  const name = asTrimmed(input.name);
  if (!name) throw new FinanceTxnError('name 必填');
  if ([...name].length > 80) throw new FinanceTxnError('name 最多 80 字');

  const amount = normalizeAmount(input.amount);
  const transactionType = normalizeTxnType(input.transaction_type);
  const happenedAt = normalizeHappenedAt(input.happened_at);
  const flowCategoryId = asTrimmed(input.flow_category_id) || null;
  const note = asTrimmed(input.note) || null;
  const aiComment = asTrimmed(input.ai_comment) || null;
  const extraData = serializeExtraData(input.extra_data);
  const skipBalance =
    input.skip_balance_check === true ||
    input.skip_balance_check === 1 ||
    input.skip_balance_check === '1';

  const account = await loadAccount(accountId);
  const signRule = normalizeSignRule(account.sign_rule, account.account_type);
  assertAmountSignForAccount(signRule, amount);
  await assertFlowCategoryExists(flowCategoryId);

  const delta = computeTransactionLedgerEffect(transactionType, amount, extraData);
  await assertBalanceAfterChange({
    accountId,
    accountName: account.name,
    signRule,
    delta,
    skip: skipBalance,
  });

  const id = asTrimmed(input.id) || randomUUID();
  if (id.length > 255) throw new FinanceTxnError('id 过长');

  const now = formatMySQLWallClockDateTime(new Date());
  try {
    await db.query(
      `INSERT INTO finance_transactions (
         id, name, happened_at, account_id, ai_comment, transaction_type, flow_category_id,
         amount, note, created_at, updated_at, sync_status, extra_data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
      [
        id,
        name,
        happenedAt,
        accountId,
        aiComment,
        transactionType,
        flowCategoryId,
        amount,
        note,
        now,
        now,
        extraData,
      ],
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new FinanceTxnError('流水已存在（id 冲突）', 409);
    }
    throw err;
  }

  const row = await getFinanceTransaction(id);
  if (!row) throw new FinanceTxnError('创建失败', 500);
  return row;
}

export async function updateFinanceTransaction(
  id: string,
  input: UpdateFinanceTxnInput,
): Promise<FinanceTxnRecord> {
  const trimmed = asTrimmed(id);
  if (!trimmed) throw new FinanceTxnError('缺少流水 id');

  const existing = await getFinanceTransaction(trimmed);
  if (!existing) throw new FinanceTxnError('流水不存在', 404);

  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);

  const accountId = has('account_id')
    ? asTrimmed(input.account_id)
    : String(existing.account_id ?? '');
  if (!accountId) throw new FinanceTxnError('account_id 必填');

  const name = has('name') ? asTrimmed(input.name) : String(existing.name ?? '');
  if (!name) throw new FinanceTxnError('name 必填');
  if ([...name].length > 80) throw new FinanceTxnError('name 最多 80 字');

  const amount = has('amount') ? normalizeAmount(input.amount) : Number(existing.amount ?? 0);
  if (!Number.isFinite(amount) || amount === 0) throw new FinanceTxnError('amount 必须为非零数字');

  const transactionType = has('transaction_type')
    ? normalizeTxnType(input.transaction_type)
    : normalizeTxnType(existing.transaction_type);

  const happenedAt = has('happened_at')
    ? normalizeHappenedAt(input.happened_at)
    : normalizeHappenedAt(existing.happened_at);

  const flowCategoryId = has('flow_category_id')
    ? asTrimmed(input.flow_category_id) || null
    : existing.flow_category_id == null
      ? null
      : String(existing.flow_category_id);

  const note = has('note')
    ? asTrimmed(input.note) || null
    : existing.note == null
      ? null
      : String(existing.note);
  const aiComment = has('ai_comment')
    ? asTrimmed(input.ai_comment) || null
    : existing.ai_comment == null
      ? null
      : String(existing.ai_comment);

  const extraData = has('extra_data')
    ? serializeExtraData(input.extra_data)
    : existing.extra_data == null
      ? null
      : typeof existing.extra_data === 'string'
        ? existing.extra_data
        : JSON.stringify(existing.extra_data);

  const skipBalance =
    input.skip_balance_check === true ||
    input.skip_balance_check === 1 ||
    input.skip_balance_check === '1';

  const oldAccountId = String(existing.account_id ?? '');
  const newDelta = computeTransactionLedgerEffect(transactionType, amount, extraData);

  const newAccount = await loadAccount(accountId);
  const newSign = normalizeSignRule(newAccount.sign_rule, newAccount.account_type);
  assertAmountSignForAccount(newSign, amount);
  await assertFlowCategoryExists(flowCategoryId);

  if (oldAccountId === accountId) {
    // 排除本行后余额 + 新 effect
    await assertBalanceAfterChange({
      accountId,
      accountName: newAccount.name,
      signRule: newSign,
      delta: newDelta,
      excludeTxnId: trimmed,
      skip: skipBalance,
    });
  } else {
    const oldAccount = await loadAccount(oldAccountId);
    const oldSign = normalizeSignRule(oldAccount.sign_rule, oldAccount.account_type);
    // 旧账户：排除本行后即为删除效果
    await assertBalanceAfterChange({
      accountId: oldAccountId,
      accountName: oldAccount.name,
      signRule: oldSign,
      delta: 0,
      excludeTxnId: trimmed,
      skip: skipBalance,
    });
    await assertBalanceAfterChange({
      accountId,
      accountName: newAccount.name,
      signRule: newSign,
      delta: newDelta,
      skip: skipBalance,
    });
  }

  const now = formatMySQLWallClockDateTime(new Date());
  await db.query(
    `UPDATE finance_transactions SET
       name = ?, happened_at = ?, account_id = ?, ai_comment = ?, transaction_type = ?,
       flow_category_id = ?, amount = ?, note = ?, extra_data = ?,
       updated_at = ?, sync_status = 'synced'
     WHERE id = ?`,
    [
      name,
      happenedAt,
      accountId,
      aiComment,
      transactionType,
      flowCategoryId,
      amount,
      note,
      extraData,
      now,
      trimmed,
    ],
  );

  const row = await getFinanceTransaction(trimmed);
  if (!row) throw new FinanceTxnError('更新失败', 500);
  return row;
}

export async function deleteFinanceTransaction(id: string): Promise<{ deleted: true; id: string }> {
  const trimmed = asTrimmed(id);
  if (!trimmed) throw new FinanceTxnError('缺少流水 id');

  const existing = await getFinanceTransaction(trimmed);
  if (!existing) throw new FinanceTxnError('流水不存在', 404);

  const accountId = String(existing.account_id ?? '');
  const account = await loadAccount(accountId);
  const signRule = normalizeSignRule(account.sign_rule, account.account_type);
  // 排除本行后校验账户余额仍合法
  await assertBalanceAfterChange({
    accountId,
    accountName: account.name,
    signRule,
    delta: 0,
    excludeTxnId: trimmed,
  });

  const [result] = await db.query<ResultSetHeader>(
    `DELETE FROM finance_transactions WHERE id = ?`,
    [trimmed],
  );
  if (result.affectedRows <= 0) {
    throw new FinanceTxnError('流水不存在', 404);
  }
  return { deleted: true, id: trimmed };
}
