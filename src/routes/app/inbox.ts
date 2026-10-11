import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  AppInboxError,
  listAppInbox,
  markAllAppInboxRead,
  markAppInboxRead,
} from '../../services/app-inbox.js';
import { DEFAULT_SYNC_USER_ID } from '../../services/sync-change-log.js';

/**
 * 资讯 / 采集收件箱 API（阶段 F）。
 * 挂载前缀：/api/app
 *
 * 未来由采集任务 INSERT app_inbox；本期不实现爬虫 / Worker / 配站后台。
 * 扩展预留：
 * 1. 后台配置扫描 URL → Worker 抓取 → INSERT app_inbox
 * 2. App 拉取后进「资讯」Tab；未读进铃铛数字
 * 3. module=health 等本期仍不打业务 Tab 角标（已锁定）
 *
 * 单租户：user_id 固定 default（与 sync 一致）；多用户时再改为 req.admin.id。
 */
const router = Router();

router.use(requireAuth);

const handleInboxError = createDomainErrorHandler(AppInboxError);

/** GET /inbox — 当前用户分页列表；无数据 → { items: [], nextCursor: null } */
router.get('/inbox', async (req, res, next) => {
  try {
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const data = await listAppInbox({
      userId: DEFAULT_SYNC_USER_ID,
      cursor,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    });
    return success(res, data);
  } catch (err) {
    handleInboxError(err, res, next);
  }
});

/** POST /inbox/read-all — 当前用户未读全部已读（须在 :id 路由之前注册） */
router.post('/inbox/read-all', async (_req, res, next) => {
  try {
    const data = await markAllAppInboxRead({ userId: DEFAULT_SYNC_USER_ID });
    return success(res, data, '已全部标为已读');
  } catch (err) {
    handleInboxError(err, res, next);
  }
});

/** POST /inbox/:id/read — 将该条 read_at=now；不存在 → 404 */
router.post('/inbox/:id/read', async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '').trim();
    if (!id) return fail(res, '缺少资讯 id', -1, 400);
    const data = await markAppInboxRead({
      userId: DEFAULT_SYNC_USER_ID,
      id,
    });
    return success(res, data, '已标为已读');
  } catch (err) {
    handleInboxError(err, res, next);
  }
});

export default router;
