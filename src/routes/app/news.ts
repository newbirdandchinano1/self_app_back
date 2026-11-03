import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { NewsImportError } from '../../services/news-import.js';
import {
  listLatestNews,
  listNewsDates,
} from '../../services/news-import.js';
import { listTrendRadarNews } from '../../services/trendradar.js';

/**
 * App 热点资讯接口。
 * 挂载前缀：/api/app
 *
 * 数据来自 TrendRadar（sqlite-sync 同步 / webhook 推送）。
 */
const router = Router();

const handleNewsError = createDomainErrorHandler(NewsImportError);

function readParam(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readInt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** GET /news/dates?limit=60 — 有数据的日期列表 */
router.get('/news/dates', requireAuth, async (req, res, next) => {
  try {
    const items = await listNewsDates(readInt(req.query.limit) ?? 60);
    return success(res, { items });
  } catch (err) {
    handleNewsError(err, res, next);
  }
});

/** GET /news/latest — 最新一天的条目 */
router.get('/news/latest', requireAuth, async (req, res, next) => {
  try {
    const data = await listLatestNews({
      platform: readParam(req.query.platform),
      keyword: readParam(req.query.keyword),
      limit: readInt(req.query.limit),
      offset: readInt(req.query.offset),
    });
    return success(res, data);
  } catch (err) {
    handleNewsError(err, res, next);
  }
});

/** GET /news/items?date=YYYY-MM-DD — 指定日期条目 */
router.get('/news/items', requireAuth, async (req, res, next) => {
  try {
    const data = await listTrendRadarNews({
      date: readParam(req.query.date),
      platform: readParam(req.query.platform),
      keyword: readParam(req.query.keyword),
      limit: readInt(req.query.limit),
      offset: readInt(req.query.offset),
    });
    return success(res, data);
  } catch (err) {
    handleNewsError(err, res, next);
  }
});

export default router;