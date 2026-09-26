import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  ProfilePageError,
  getProfileMemoList,
  getProfileRecipes,
  getProfilePoints,
  getProfileWishBoard,
} from '../../services/pages/profile.js';

/**
 * 「我的」Tab / 画像子页专用接口。
 * 挂载前缀：/api/app
 * APP 只打 /api/app/pages/profile/* ，不要再为读路径降级到 /api/app/data/* List。
 */
const router = Router();

router.use(requireAuth);

const handleProfileError = createDomainErrorHandler(ProfilePageError);

/** GET /pages/profile/memo-list — 备忘录列表子页 */
router.get('/pages/profile/memo-list', async (_req, res, next) => {
  try {
    const data = await getProfileMemoList();
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /pages/profile/points — 积分钱包/流水子页 */
router.get('/pages/profile/points', async (_req, res, next) => {
  try {
    const data = await getProfilePoints();
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /pages/profile/wish-board — 心愿板子页 */
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
