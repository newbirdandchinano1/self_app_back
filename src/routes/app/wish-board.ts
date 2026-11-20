import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { syncWriteOptionsFromReq } from '../../utils/device-id-from-req.js';
import {
  createWishBoardItem,
  deleteRedeemedWishBoardItems,
  deleteWishBoardItem,
  evaluateWishBoardEligibility,
  getWishBoardItem,
  listActiveWishBoardItems,
  listRedeemedWishBoardItems,
  redeemWishBoardItem,
  updateWishBoardItem,
  updateWishBoardRedeemConditions,
  WishBoardError,
} from '../../services/wish-board.js';

const router = Router();

router.use(requireAuth);

const handleWishBoardError = createDomainErrorHandler(WishBoardError, {
  includeBodyExtras: true,
});

/** GET /wish-board/items — 可兑换心愿（status=active） */
router.get('/wish-board/items', async (_req, res, next) => {
  try {
    const items = await listActiveWishBoardItems();
    return success(res, { items, total: items.length });
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

/** POST /wish-board/items — 新增心愿 */
router.post('/wish-board/items', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const item = await createWishBoardItem(
      {
        id: typeof body.id === 'string' ? body.id : null,
        title: body.title,
        description: body.description,
        cost_points: body.cost_points,
        note: body.note,
        icon_key: body.icon_key,
        wish_type: body.wish_type,
        sort_order: body.sort_order,
        extra_data: body.extra_data,
        redeem_conditions: Object.prototype.hasOwnProperty.call(body, 'redeem_conditions')
          ? body.redeem_conditions
          : undefined,
      },
      syncWriteOptionsFromReq(req),
    );
    return success(res, item, '创建成功');
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

/**
 * GET /wish-board/items/:id/eligibility — 兑换资格（积分 + 绑定条件 + 净资产 + 开放时间）
 * Agent：查看兑换资格
 */
router.get('/wish-board/items/:id/eligibility', async (req, res, next) => {
  try {
    const data = await evaluateWishBoardEligibility(String(req.params.id ?? ''));
    return success(res, data);
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

/**
 * GET /wish-board/items/:id/gap — 兑换缺口 + 引导补齐（深链 / module_id；不自动兑）
 * Agent：查看兑换缺口 / 引导补齐缺口
 */
router.get('/wish-board/items/:id/gap', async (req, res, next) => {
  try {
    const data = await evaluateWishBoardEligibility(String(req.params.id ?? ''));
    return success(res, {
      wish_id: data.wish_id,
      title: data.title,
      ok: data.ok,
      points_gap: data.points_gap,
      balance: data.balance,
      cost_points: data.cost_points,
      current_net_worth: data.current_net_worth,
      pending: data.pending,
      guides: data.guides,
      message: data.message,
      note: '仅引导跳转补齐缺口；兑换须用户在心愿板页内确认，助手不可代兑。',
    });
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

/**
 * PUT /wish-board/items/:id/redeem-conditions — 设置 / 清除兑换条件
 * body：完整 redeem_conditions；传 null / {} 清除全部附加条件
 * Agent：绑定完成条件 / 习惯 / 净资产 / 开放时间 / 清除兑换条件
 */
router.put('/wish-board/items/:id/redeem-conditions', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const raw = Object.prototype.hasOwnProperty.call(body, 'redeem_conditions')
      ? body.redeem_conditions
      : body;
    const conditions =
      raw == null ||
      (typeof raw === 'object' &&
        !Array.isArray(raw) &&
        Object.keys(raw as Record<string, unknown>).length === 0)
        ? null
        : raw;
    const item = await updateWishBoardRedeemConditions(
      String(req.params.id ?? ''),
      conditions,
      syncWriteOptionsFromReq(req),
    );
    return success(res, item, '兑换条件已更新');
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

/** GET /wish-board/items/:id — 心愿详情 */
router.get('/wish-board/items/:id', async (req, res, next) => {
  try {
    const item = await getWishBoardItem(String(req.params.id ?? ''));
    if (!item) {
      throw new WishBoardError('心愿不存在', 404, { ok: false, error: '心愿不存在' });
    }
    return success(res, item);
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

/** PATCH /wish-board/items/:id — 更新心愿（不可改兑换状态） */
router.patch('/wish-board/items/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const item = await updateWishBoardItem(
      String(req.params.id ?? ''),
      {
        title: body.title,
        description: body.description,
        cost_points: body.cost_points,
        note: body.note,
        icon_key: body.icon_key,
        wish_type: body.wish_type,
        sort_order: body.sort_order,
        extra_data: body.extra_data,
        ...(Object.prototype.hasOwnProperty.call(body, 'redeem_conditions')
          ? { redeem_conditions: body.redeem_conditions }
          : {}),
      },
      syncWriteOptionsFromReq(req),
    );
    return success(res, item, '更新成功');
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

/** DELETE /wish-board/items/:id — 删除心愿 */
router.delete('/wish-board/items/:id', async (req, res, next) => {
  try {
    const data = await deleteWishBoardItem(String(req.params.id ?? ''), {
      ...syncWriteOptionsFromReq(req),
    });
    return success(res, data, '删除成功');
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

/** GET /wish-board/redeemed — 已兑换记录（wish_redeem 流水） */
router.get('/wish-board/redeemed', async (_req, res, next) => {
  try {
    const items = await listRedeemedWishBoardItems();
    return success(res, { items, total: items.length });
  } catch (err) {
    handleWishBoardError(err, res, next);
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
    const data = await deleteRedeemedWishBoardItems(idRaw, {
      ...syncWriteOptionsFromReq(req),
    });
    return success(res, data, '删除成功');
  } catch (err) {
    handleWishBoardError(err, res, next);
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

    const result = await redeemWishBoardItem(wishBoardItemId, {
      ...syncWriteOptionsFromReq(req),
    });
    const { ok: _ok, ...data } = result;
    return success(res, data);
  } catch (err) {
    handleWishBoardError(err, res, next);
  }
});

export default router;
