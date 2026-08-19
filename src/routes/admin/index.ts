import { Router } from 'express';
import { concurrencyConfig } from '../../config/index.js';
import { createConcurrencyMiddleware } from '../../middlewares/concurrency.js';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import uploadsRouter from './uploads.js';

/**
 * Admin console API.
 * Mount prefix: /api/admin
 */
const router = Router();

const apiConcurrency = createConcurrencyMiddleware(
  'api',
  concurrencyConfig.apiMax,
  concurrencyConfig.enabled,
);

router.use(apiConcurrency);

router.get('/health', (_req, res) => {
  success(res, { scope: 'admin', status: 'ok' });
});

router.use('/uploads', requireAuth, uploadsRouter);

export default router;
