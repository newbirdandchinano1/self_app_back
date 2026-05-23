import { Router } from 'express';
import { success } from '../utils/response.js';

const router = Router();

router.get('/health', (_req, res) => {
  success(res, { status: 'ok', uptime: process.uptime() });
});

export default router;
