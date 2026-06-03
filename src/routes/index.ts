import { Router } from 'express';
import healthRouter from './health.js';
import homeRouter from './home.js';
import crudRouter from './crud.js';
import authRouter from './auth.js';
import aiRouter from './ai.js';

const router = Router();

router.use(homeRouter);
router.use(healthRouter);
router.use('/api/auth', authRouter);
router.use('/api/ai', aiRouter);
router.use('/api', crudRouter);

export default router;
