import express from 'express';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import path from 'path';
import routes from './routes/index.js';
import { errorHandler } from './middlewares/error-handler.js';
import { UPLOAD_ROOT } from './config/uploads.js';

const app = express();
const publicDir = path.join(process.cwd(), 'public');

app.use(cors());
// SSE 长连接禁止压缩缓冲，否则心跳/事件会被攒批
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.includes('/sync/stream')) return false;
      const accept = req.headers.accept ?? '';
      if (typeof accept === 'string' && accept.includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }),
);
app.use(morgan('dev'));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(express.static(publicDir));
app.use('/uploads', express.static(UPLOAD_ROOT));

app.use(routes);
app.use(errorHandler);

export default app;