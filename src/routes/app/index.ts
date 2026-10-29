import { Router } from 'express';
import { concurrencyConfig } from '../../config/index.js';
import { createConcurrencyMiddleware } from '../../middlewares/concurrency.js';
import authRouter from './auth.js';
import pagesRouter from './pages.js';
import calendarRouter from './calendar.js';
import pointsRouter from './points.js';
import wishBoardRouter from './wish-board.js';
import recipesRouter from './recipes.js';
import memosRouter from './memos.js';
import healthRouter from './health.js';
import financeRouter from './finance.js';
import reviewRouter from './review.js';
import profileRouter from './profile.js';
import crudRouter from './crud.js';
import syncRouter from './sync.js';
import inboxRouter from './inbox.js';
import imagesRouter from './images.js';

/**
 * App-facing API (mobile / client).
 * Mount prefix: /api/app
 * 场景 AI 已迁至 selfAPP_AIAgent（/api/v1/ai）；本服务仅保留业务 CRUD / 同步 / 备忘落库点评等。
 */
const router = Router();

const apiConcurrency = createConcurrencyMiddleware(
  'api',
  concurrencyConfig.apiMax,
  concurrencyConfig.enabled,
);

router.use(apiConcurrency);
router.use('/auth', authRouter);
router.use('/sync', syncRouter);
router.use(pagesRouter);
router.use(calendarRouter);
router.use(pointsRouter);
router.use(wishBoardRouter);
router.use(recipesRouter);
router.use(memosRouter);
router.use(healthRouter);
router.use(financeRouter);
router.use(reviewRouter);
router.use(profileRouter);
router.use(inboxRouter);
router.use(imagesRouter);
router.use(crudRouter);

export default router;
