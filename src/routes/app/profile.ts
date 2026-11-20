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
import {
  ProfilePrefsError,
  getDietaryPrefs,
  putDietaryPrefs,
  updateWorkoutDays,
} from '../../services/profile-prefs.js';
import { getAgentProfileSnapshot } from '../../services/agent/snapshot-profile.js';

/**
 * 「我的」Tab / 画像子页专用接口。
 * 挂载前缀：/api/app
 * APP 只打 /api/app/pages/profile/* ，不要再为读路径降级到 /api/app/data/* List。
 */
const router = Router();

router.use(requireAuth);

const handleProfileError = createDomainErrorHandler([ProfilePageError, ProfilePrefsError]);

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

/** GET /pages/profile/hub — 我的页首页摘要（完整度/节奏/体重/饮食） */
router.get('/pages/profile/hub', async (req, res, next) => {
  try {
    const logicalToday =
      typeof req.query.logicalToday === 'string'
        ? req.query.logicalToday
        : typeof req.query.today === 'string'
          ? req.query.today
          : undefined;
    const data = await getAgentProfileSnapshot({ logicalToday });
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /pages/profile/dietary — 饮食偏好 */
router.get('/pages/profile/dietary', async (_req, res, next) => {
  try {
    const data = await getDietaryPrefs();
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** PUT /pages/profile/dietary — 更新饮食偏好（标签+备注） */
router.put('/pages/profile/dietary', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await putDietaryPrefs(body.prefs ?? body);
    success(res, data, '已更新饮食偏好');
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/**
 * PUT /pages/profile/workout-days — 设置健身日
 * 非健身习惯会清空；可顺带传 lifestyle
 */
router.put('/pages/profile/workout-days', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateWorkoutDays({
      workout_days: body.workout_days ?? body.workoutDays ?? body.days,
      lifestyle: body.lifestyle,
    });
    success(res, data, data.cleared ? '非健身习惯，已清空健身日' : '已更新健身日');
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

export default router;
