import { Router } from 'express';
import healthRouter from './health.js';
import homeRouter from './home.js';

const router = Router();

router.use(homeRouter);
router.use(healthRouter);

// 在这里注册更多路由
// router.use('/api/users', userRouter);

export default router;
