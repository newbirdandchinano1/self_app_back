import { Router } from 'express';
import { success } from '../utils/response.js';
import { countSyncSseConnections } from '../services/sync-sse-hub.js';
import { getSyncMetricsSnapshot } from '../services/sync-metrics.js';

const router = Router();

router.get('/health', (_req, res) => {
  success(res, {
    status: 'ok',
    uptime: process.uptime(),
    sync: {
      sseOnline: countSyncSseConnections(),
      metrics: getSyncMetricsSnapshot(),
    },
  });
});

export default router;
