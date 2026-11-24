import { Router } from 'express';
import { createAppConcurrencyMiddleware } from '../../middlewares/concurrency.js';
import authRouter from './auth.js';
import pagesRouter from './pages.js';
import calendarRouter from './calendar.js';
import pointsRouter from './points.js';
import wishBoardRouter from './wish-board.js';
import recipesRouter from './recipes.js';
import wardrobeRouter from './wardrobe.js';
import memosRouter from './memos.js';
import healthRouter from './health.js';
import financeRouter from './finance.js';
import agentRouter from './agent.js';
import reviewRouter from './review.js';
import profileRouter from './profile.js';
import crudRouter from './crud.js';
import syncRouter from './sync.js';
import inboxRouter from './inbox.js';
import remindersRouter from './reminders.js';
import imagesRouter from './images.js';
import trendradarRouter from './trendradar.js';
import newsRouter from './news.js';
import externalRouter from './external.js';

/**
 * App-facing API (mobile / client).
 * Mount prefix: /api/app
 * 场景 AI 已迁至 selfAPP_AIAgent（/api/v1/ai）；本服务仅保留业务 CRUD / 同步 / 备忘落库点评等。
 *
 * 并发：分池（light / page / sync / write）+ 可选全局帽 + 单用户上限；
 * SSE `/sync/stream` 与 `/agent/*` 不占槽（见 shouldSkipConcurrency）。
 */
const router = Router();

router.use(createAppConcurrencyMiddleware());
router.use('/auth', authRouter);
router.use('/sync', syncRouter);
// 必须在任何 `router.use(requireAuth)` 的路由之前挂载，保证 webhook 公开可达
router.use('/trendradar', trendradarRouter);
router.use(newsRouter);
router.use(pagesRouter);
router.use(calendarRouter);
router.use(pointsRouter);
router.use(wishBoardRouter);
router.use(recipesRouter);
router.use(wardrobeRouter);
router.use(memosRouter);
router.use(healthRouter);
router.use(financeRouter);
router.use(agentRouter);
router.use(reviewRouter);
router.use(profileRouter);
router.use(inboxRouter);
router.use(remindersRouter);
router.use(imagesRouter);
router.use(externalRouter);
router.use(crudRouter);

export default router;
