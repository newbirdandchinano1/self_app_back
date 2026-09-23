import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import {
  createWishBoardItem,
  deleteRedeemedWishBoardItems,
  deleteWishBoardItem,
  listActiveWishBoardItems,
  listRedeemedWishBoardItems,
  redeemWishBoardItem,
  WishBoardError,
} from '../../services/wish-board.js';

const router = Router();

router.use(requireAuth);

function sendWishBoardError(res: import('express').Response, err: WishBoardError) {
  const { ok: _ok, error: _error, ...rest } = err.body;
  return fail(res, err.message, -1, err.status, Object.keys(rest).length ? rest : null);
}

/** GET /wish-board/items — 可兑换心愿（status=active） */
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

/** POST /wish-board/items — 新增心愿 */
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
      extra_data: body.extra_data,
    });
    return success(res, item, '创建成功');
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** DELETE /wish-board/items/:id — 删除心愿 */
router.delete('/wish-board/items/:id', async (req, res, next) => {
  try {
    const data = await deleteWishBoardItem(String(req.params.id ?? ''));
    return success(res, data, '删除成功');
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** GET /wish-board/redeemed — 已兑换记录（wish_redeem 流水） */
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
 * DELETE /wish-board/redeemed — 删除已兑换心愿
 * - 有 body/query id：仅删该 status=redeemed 行
 * - 无 id：清空全部已兑换
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
    return success(res, data, '删除成功');
  } catch (err) {
    if (err instanceof WishBoardError) {
      return sendWishBoardError(res, err);
    }
    next(err);
  }
});

/** POST /wish-board/redeem — 兑换心愿（body.id 或 wish_board_item_id） */
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

export default router;
