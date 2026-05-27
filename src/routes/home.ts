import { Router } from 'express';
import path from 'path';

const router = Router();

const homePagePath = path.join(process.cwd(), 'public', 'home.html');

router.get('/', (_req, res) => {
  res.redirect(302, '/home');
});

router.get('/home', (_req, res) => {
  res.sendFile(homePagePath);
});

export default router;
