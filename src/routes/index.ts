import { Router } from 'express';
import healthRouter from './health.js';
import homeRouter from './home.js';
import appRouter from './app/index.js';
import adminRouter from './admin/index.js';

const router = Router();

router.use(homeRouter);
router.use(healthRouter);

/** App API: /api/app/* */
router.use('/api/app', appRouter);

/** Admin API: /api/admin/* */
router.use('/api/admin', adminRouter);

/**
 * Legacy alias: existing clients still use /api/*
 * Remove after clients migrate to /api/app.
 */
router.use('/api', appRouter);

export default router;
