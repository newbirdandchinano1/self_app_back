import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { getProjectList } from '../../services/pages/project-list.js';
import { success } from '../../utils/response.js';
import { parseListFilterParams } from './pages/query.js';
import tasksRouter from './pages/tasks.js';

const router = Router();

router.use(requireAuth);

router.get('/pages/projects', async (req, res, next) => {
  try {
    const data = await getProjectList(parseListFilterParams(req));
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.use(tasksRouter);

export default router;
