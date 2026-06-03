import { Router } from 'express';
import { success, fail } from '../utils/response.js';
import { loginAdmin } from '../services/auth.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return fail(res, '请输入账号和密码');
    }

    const result = await loginAdmin(String(username), String(password));
    if (!result) {
      return fail(res, '账号或密码错误', -1, 401);
    }

    success(res, result, '登录成功');
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  success(res, { admin: req.admin });
});

export default router;
