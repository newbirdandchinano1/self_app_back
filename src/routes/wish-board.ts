import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { success, fail } from '../utils/response.js';
import {
  adjustPoints,
  getPointsBalance,
  redeemWishBoardItem,
  WishBoardError,
} from '../services/wish-board.js';

const router = Router();

router.use(requireAuth);

function sendWishBoardError(res: import('express').Response, err: WishBoardError) {
  const { ok: _ok, error: _error, ...rest } = err.body;
  return fail(res, err.message, -1, err.status, Object.keys(rest).length ? rest : null);
}

/** POST /api/wish-board/redeem — 原子兑换（body.id 或 wish_board_item_id） */
router.post('/wish-board/redeem', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const wishBoardItemId =
      typeof body.id === 'string' && body.id.trim()
        ? body.id
        : typeof body.wish_board_item_id === 'string'
          ? body.wish_board_item_id
          : '';
    if (!wishBoardItemId.trim()) {
      return fail(res, '参数缺失');
    }

    const result = await redeemWishBoardItem(wishBoardItemId);
    const { ok: _ok, ...data } = result;
    return success(res, data);
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** POST /api/wish-board/points/adjust — 积分增减（习惯/任务/项目发奖与扣回、手动调整） */
router.post('/wish-board/points/adjust', async (req, res, next) => {
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
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** GET /api/wish-board/points/balance — 快捷查余额 */
router.get('/wish-board/points/balance', async (_req, res, next) => {
  try {
    const result = await getPointsBalance();
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

export default router;
