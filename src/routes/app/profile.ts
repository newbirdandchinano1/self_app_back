import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { fail, success } from '../../utils/response.js';
import {
  ProfilePageError,
  getProfileMemoList,
  getProfileRecipes,
  getProfilePoints,
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
