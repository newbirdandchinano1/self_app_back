import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import {
  adjustPoints,
  deletePointsLedgerEntry,
  getPointsBalance,
  listPointsLedgerHistory,
  PointsError,
  resetPoints,
} from '../../services/points.js';

const router = Router();

router.use(requireAuth);

function sendPointsError(res: import('express').Response, err: PointsError) {
  const { ok: _ok, error: _error, ...rest } = err.body;
  return fail(res, err.message, -1, err.status, Object.keys(rest).length ? rest : null);
}

/** POST /points/adjust — 任务/习惯等调账 */
router.post('/points/adjust', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const deltaRaw = body.delta;
    const delta =
      typeof deltaRaw === 'number'
        ? deltaRaw
        : typeof deltaRaw === 'string'
          ? Number(deltaRaw)
          : NaN;

    const result = await adjustPoints({
      delta,
      reason: typeof body.reason === 'string' ? body.reason : '',
      ref_type: typeof body.ref_type === 'string' ? body.ref_type : null,
      ref_id: typeof body.ref_id === 'string' ? body.ref_id : null,
      note: typeof body.note === 'string' ? body.note : null,
    });
    const { ok: _ok, ...data } = result;
    return success(res, data);
  } catch (err) {
    if (err instanceof PointsError) {
      return sendPointsError(res, err);
    }
    next(err);
  }
});

/** GET /points/balance — 积分余额 */
router.get('/points/balance', async (_req, res, next) => {
  try {
    const result = await getPointsBalance();
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /points/ledger — 积分流水（全部来源）
 * Query: page (default 1), limit (default 50, max 200)
 */
router.get('/points/ledger', async (req, res, next) => {
  try {
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : Number(req.query.page);
    const limitRaw =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : Number(req.query.limit);
    const result = await listPointsLedgerHistory({
      page: Number.isFinite(pageRaw) ? pageRaw : 1,
      limit: Number.isFinite(limitRaw) ? limitRaw : 50,
    });
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /points/ledger — 删除一条流水并回退积分
 * Query/body: id = ledger id
 */
router.delete('/points/ledger', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const idRaw =
      typeof body.id === 'string' && body.id.trim()
        ? body.id
        : typeof req.query.id === 'string'
          ? req.query.id
          : '';
    if (!String(idRaw).trim()) {
      return fail(res, '参数缺失');
    }
    const data = await deletePointsLedgerEntry(String(idRaw));
    return success(res, data);
  } catch (err) {
    if (err instanceof PointsError) {
      return sendPointsError(res, err);
    }
    next(err);
  }
});

/** DELETE /points/ledger/:id — 同上，路径参数形式 */
router.delete('/points/ledger/:id', async (req, res, next) => {
  try {
    const data = await deletePointsLedgerEntry(String(req.params.id ?? ''));
    return success(res, data);
  } catch (err) {
    if (err instanceof PointsError) {
      return sendPointsError(res, err);
    }
    next(err);
  }
});

/** POST /points/reset — 清零余额并写 points_reset 流水 */
router.post('/points/reset', async (_req, res, next) => {
  try {
    const data = await resetPoints();
    return success(res, data);
  } catch (err) {
    if (err instanceof PointsError) {
      return sendPointsError(res, err);
    }
    next(err);
  }
});

export default router;
