import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { trendRadarConfig } from '../../config/index.js';
import {
  TrendRadarError,
  ingestTrendRadarWebhook,
  listTrendRadarNews,
  listTrendRadarReports,
} from '../../services/trendradar.js';

/**
 * TrendRadar 热点推送接入。
 * 挂载前缀：/api/app/trendradar
 *
 * - POST /webhook  公开接口，供 TrendRadar 通用 Webhook 回调（URL 带 token）
 * - GET  /reports  已入库报告列表（需登录）
 * - GET  /news     报告条目列表（需登录）
 */
const router = Router();

const handleTrendRadarError = createDomainErrorHandler(TrendRadarError);

function readToken(req: { query: unknown; headers: Record<string, unknown> }): string {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const fromQuery = typeof q.token === 'string' ? q.token : '';
  const header = req.headers['x-trendradar-token'];
  const fromHeader = typeof header === 'string' ? header : '';
  return (fromQuery || fromHeader).trim();
}

/** POST /webhook — TrendRadar 通用 Webhook 回调（无需登录，靠 token 校验） */
router.post('/webhook', async (req, res, next) => {
  try {
    const expected = trendRadarConfig.webhookToken;
    if (expected) {
      const actual = readToken(req as never);
      if (actual !== expected) {
        return fail(res, 'token 无效', -1, 401);
      }
    }
    const body = (req.body ?? {}) as { title?: unknown; content?: unknown };
    const data = await ingestTrendRadarWebhook(body);
    console.log(
      `[TrendRadar] 入库 report=${data.reportId} batch=${data.batchIndex}/${data.batchTotal} items=${data.itemsParsed}`,
    );
    return success(res, data, 'ok');
  } catch (err) {
    handleTrendRadarError(err, res, next);
  }
});

router.use(requireAuth);

/** GET /reports?date=YYYY-MM-DD&limit=20 */
router.get('/reports', async (req, res, next) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : null;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const items = await listTrendRadarReports({
      date,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    });
    return success(res, { items });
  } catch (err) {
    handleTrendRadarError(err, res, next);
  }
});

/** GET /news?reportId=&date=&keyword=&platform=&limit=100&offset=0 */
router.get('/news', async (req, res, next) => {
  try {
    const q = req.query;
    const reportIdRaw = typeof q.reportId === 'string' ? Number(q.reportId) : undefined;
    const limitRaw = typeof q.limit === 'string' ? Number(q.limit) : undefined;
    const offsetRaw = typeof q.offset === 'string' ? Number(q.offset) : undefined;
    const data = await listTrendRadarNews({
      reportId: Number.isFinite(reportIdRaw) ? reportIdRaw : null,
      date: typeof q.date === 'string' ? q.date : null,
      keyword: typeof q.keyword === 'string' ? q.keyword : null,
      platform: typeof q.platform === 'string' ? q.platform : null,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      offset: Number.isFinite(offsetRaw) ? offsetRaw : undefined,
    });
    return success(res, data);
  } catch (err) {
    handleTrendRadarError(err, res, next);
  }
});

export default router;