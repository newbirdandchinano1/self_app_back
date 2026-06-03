// app.ts 修改如下：
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import routes from './routes/index.js';
import { errorHandler } from './middlewares/error-handler.js';
import path from 'path'; // 引入 path

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 👇 加上这一行！把 public 目录作为静态资源暴露出去
app.use(express.static('public'));

app.use(routes);
app.use(errorHandler);

export default app;