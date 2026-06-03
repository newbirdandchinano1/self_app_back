import { Router } from 'express';
import path from 'path';

const router = Router();

const publicDir = path.join(process.cwd(), 'public');

router.get('/', (_req, res) => {
  res.redirect(302, '/login');
});

router.get('/login', (_req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

router.get('/admin', (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

router.get('/home', (_req, res) => {
  res.sendFile(path.join(publicDir, 'home.html'));
});

export default router;
