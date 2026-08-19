import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { fail, success } from '../../utils/response.js';
import { parseIntQuery } from './pages/query.js';
import {
  ProfilePageError,
  getProfileHome,
  getProfileMemoList,
  getProfileRecipes,
  getProfileVisionWall,
  getProfileWishBoard,
  getProfileWishList,
} from '../../services/pages/profile.js';

/**
 * 「我的」Tab / 画像子页专用接口。
 * 挂载前缀：/api 与 /api/app
 * APP 只打 /api/pages/profile/* ，不要再为读路径降级到 /api/data/* List。
 */
const router = Router();

router.use(requireAuth);

function handleProfileError(
  err: unknown,
  res: Parameters<typeof fail>[0],
  next: (err: unknown) => void,
) {
  if (err instanceof ProfilePageError) {
    return fail(res, err.message, -1, err.status);
  }
  next(err);
}

/** GET /pages/profile/home — 「我的」Tab 冷启动 / 下拉刷新 */
router.get('/pages/profile/home', async (req, res, next) => {
  try {
    const data = await getProfileHome({
      wishPreviewLimit: parseIntQuery(req.query.wishPreviewLimit),
    });
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /pages/profile/wish-list — 心愿清单子页（含攒钱关联） */
router.get('/pages/profile/wish-list', async (_req, res, next) => {
  try {
    const data = await getProfileWishList();
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /pages/profile/memo-list — 备忘录列表子页 */
router.get('/pages/profile/memo-list', async (_req, res, next) => {
  try {
    const data = await getProfileMemoList();
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /pages/profile/vision-wall — 愿景墙 / 目标维度子页 */
router.get('/pages/profile/vision-wall', async (_req, res, next) => {
  try {
    const data = await getProfileVisionWall();
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /pages/profile/wish-board — 积分看板子页 */
router.get('/pages/profile/wish-board', async (_req, res, next) => {
  try {
    const data = await getProfileWishBoard();
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /pages/profile/recipes — 我的菜谱子页 */
router.get('/pages/profile/recipes', async (_req, res, next) => {
  try {
    const data = await getProfileRecipes();
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

export default router;
