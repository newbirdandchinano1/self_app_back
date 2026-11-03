import { Router } from 'express';
import healthRouter from './health.js';
import homeRouter from './home.js';
import appRouter from './app/index.js';
import adminRouter from './admin/index.js';
import newsRouter from './news.js';

const router = Router();

router.use(homeRouter);
router.use(healthRouter);

/** App API: /api/app/* */
router.use('/api/app', appRouter);

/** Admin API: /api/admin/* */
router.use('/api/admin', adminRouter);

/** 同步脚本 API: /api/news/* */
router.use('/api/news', newsRouter);

export default router;
