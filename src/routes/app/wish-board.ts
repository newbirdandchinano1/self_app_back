import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import {
  adjustPoints,
  createWishBoardItem,
  deleteRedeemedWishBoardItems,
  deleteWishBoardItem,
  getPointsBalance,
  listActiveWishBoardItems,
  listPointsLedgerHistory,
  listRedeemedWishBoardItems,
  redeemWishBoardItem,
  resetPoints,
  WishBoardError,
} from '../../services/wish-board.js';

const router = Router();

router.use(requireAuth);

function sendWishBoardError(res: import('express').Response, err: WishBoardError) {
  const { ok: _ok, error: _error, ...rest } = err.body;
  return fail(res, err.message, -1, err.status, Object.keys(rest).length ? rest : null);
}

/** GET /wish-board/items � ???????status=active? */
router.get('/wish-board/items', async (_req, res, next) => {
  try {
    const items = await listActiveWishBoardItems();
    return success(res, { items, total: items.length });
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** POST /wish-board/items � ????? */
router.post('/wish-board/items', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const item = await createWishBoardItem({
      id: typeof body.id === 'string' ? body.id : null,
      title: body.title,
      description: body.description,
      cost_points: body.cost_points,
      note: body.note,
      icon_key: body.icon_key,
      wish_type: body.wish_type,
      sort_order: body.sort_order,
    });
    return success(res, item, '????');
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** DELETE /wish-board/items/:id � ???? */
router.delete('/wish-board/items/:id', async (req, res, next) => {
  try {
    const data = await deleteWishBoardItem(String(req.params.id ?? ''));
    return success(res, data, '????');
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** GET /wish-board/redeemed � ??????????wish_redeem ??? */
router.get('/wish-board/redeemed', async (_req, res, next) => {
  try {
    const items = await listRedeemedWishBoardItems();
    return success(res, { items, total: items.length });
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/**
 * DELETE /wish-board/redeemed � ???????
 * - ? body/query id????? status=redeemed
 * - ? id???????????
 */
router.delete('/wish-board/redeemed', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const idRaw =
      typeof body.id === 'string' && body.id.trim()
        ? body.id
        : typeof req.query.id === 'string'
          ? req.query.id
          : null;
    const data = await deleteRedeemedWishBoardItems(idRaw);
    return success(res, data, '????');
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** POST /wish-board/redeem � ?????body.id ? wish_board_item_id? */
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
      return fail(res, '????');
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

/** POST /wish-board/points/adjust � ???????/??/????????????? */
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

/** GET /wish-board/points/balance � ?????? */
router.get('/wish-board/points/balance', async (_req, res, next) => {
  try {
    const result = await getPointsBalance();
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /wish-board/points/ledger — 积分流水（全部来源）
 * Query: page (default 1), limit (default 50, max 200)
 */
router.get('/wish-board/points/ledger', async (req, res, next) => {
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

/** POST /wish-board/points/reset � ????????? + points_reset ??? */
router.post('/wish-board/points/reset', async (_req, res, next) => {
  try {
    const data = await resetPoints();
    return success(res, data);
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

export default router;
