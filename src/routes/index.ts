import { Router } from 'express';
import { concurrencyConfig } from '../config/index.js';
import { createConcurrencyMiddleware } from '../middlewares/concurrency.js';
import healthRouter from './health.js';
import homeRouter from './home.js';
import crudRouter from './crud.js';
import calendarRouter from './calendar.js';
import authRouter from './auth.js';
import aiRouter from './ai.js';

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

router.use(homeRouter);
router.use(healthRouter);
router.use('/api/auth', apiConcurrency, authRouter);
router.use('/api/ai', aiConcurrency, aiRouter);
router.use('/api', apiConcurrency, calendarRouter);
router.use('/api', apiConcurrency, crudRouter);

export default router;
