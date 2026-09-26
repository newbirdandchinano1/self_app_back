import { Router } from 'express';
import { concurrencyConfig } from '../../config/index.js';
import { createConcurrencyMiddleware } from '../../middlewares/concurrency.js';
import authRouter from './auth.js';
import aiRouter from './ai.js';
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

/**
 * App-facing API (mobile / client).
 * Mount prefix: /api/app
 */
const router = Router();

const apiConcurrency = createConcurrencyMiddleware(
  'api',
  concurrencyConfig.apiMax,
  concurrencyConfig.enabled,
);
const aiConcurrency = createConcurrencyMiddleware(
  'ai',
  concurrencyConfig.aiMax,
  concurrencyConfig.enabled,
);

// AI 走独立限流；其余路由只挂一次 apiConcurrency，避免同一响应重复注册 finish/close
router.use('/ai', aiConcurrency, aiRouter);
router.use(apiConcurrency);
router.use('/auth', authRouter);
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
router.use(crudRouter);

export default router;
