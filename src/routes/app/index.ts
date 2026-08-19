import { Router } from 'express';
import { concurrencyConfig } from '../../config/index.js';
import { createConcurrencyMiddleware } from '../../middlewares/concurrency.js';
import authRouter from './auth.js';
import aiRouter from './ai.js';
import pagesRouter from './pages.js';
import calendarRouter from './calendar.js';
import wishBoardRouter from './wish-board.js';
import recipesRouter from './recipes.js';
import memosRouter from './memos.js';
import healthRouter from './health.js';
import financeRouter from './finance.js';
import reviewRouter from './review.js';
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

router.use('/auth', apiConcurrency, authRouter);
router.use('/ai', aiConcurrency, aiRouter);
router.use(apiConcurrency, pagesRouter);
router.use(apiConcurrency, calendarRouter);
router.use(apiConcurrency, wishBoardRouter);
router.use(apiConcurrency, recipesRouter);
router.use(apiConcurrency, memosRouter);
router.use(apiConcurrency, healthRouter);
router.use(apiConcurrency, financeRouter);
router.use(apiConcurrency, reviewRouter);
router.use(apiConcurrency, crudRouter);

export default router;
