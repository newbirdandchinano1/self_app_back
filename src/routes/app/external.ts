import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { ExternalApiError } from '../../services/external/errors.js';
import {
  getWeatherAir,
  getWeatherDaily,
  getWeatherHourly,
  getWeatherNow,
  getWeatherSummary,
} from '../../services/external/qweather.js';
import {
  getHoroscope,
  listHoroscopeSigns,
  parseHoroscopeScopes,
} from '../../services/external/horoscope.js';

/**
 * 外部 API 网关（第三方能力统一出口）。
 * 挂载前缀：/api/app
 *
 * - 和风天气（经纬度；未传则默认成都）
 * - 星座运势 ShowAPI 872-1
 */
const router = Router();

router.use(requireAuth);

const handleExternalError = createDomainErrorHandler(ExternalApiError);

function readFloat(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function locationFromQuery(query: Record<string, unknown>) {
  return {
    lat: readFloat(query.lat),
    lng: readFloat(query.lng),
    label: typeof query.label === 'string' ? query.label : undefined,
  };
}

/**
 * GET /external/weather
 * 聚合：实时 + 逐日 + 逐时 + 空气质量
 * query: lat, lng, label?, days?=7, hours?=24
 */
router.get('/external/weather', async (req, res, next) => {
  try {
    const data = await getWeatherSummary({
      ...locationFromQuery(req.query as Record<string, unknown>),
      days: readInt(req.query.days),
      hours: readInt(req.query.hours),
    });
    success(res, data);
  } catch (err) {
    handleExternalError(err, res, next);
  }
});

/** GET /external/weather/now */
router.get('/external/weather/now', async (req, res, next) => {
  try {
    const data = await getWeatherNow(locationFromQuery(req.query as Record<string, unknown>));
    success(res, data);
  } catch (err) {
    handleExternalError(err, res, next);
  }
});

/** GET /external/weather/daily?days=7 */
router.get('/external/weather/daily', async (req, res, next) => {
  try {
    const data = await getWeatherDaily({
      ...locationFromQuery(req.query as Record<string, unknown>),
      days: readInt(req.query.days),
    });
    success(res, data);
  } catch (err) {
    handleExternalError(err, res, next);
  }
});

/** GET /external/weather/hourly?hours=24 */
router.get('/external/weather/hourly', async (req, res, next) => {
  try {
    const data = await getWeatherHourly({
      ...locationFromQuery(req.query as Record<string, unknown>),
      hours: readInt(req.query.hours),
    });
    success(res, data);
  } catch (err) {
    handleExternalError(err, res, next);
  }
});

/** GET /external/weather/air */
router.get('/external/weather/air', async (req, res, next) => {
  try {
    const data = await getWeatherAir(locationFromQuery(req.query as Record<string, unknown>));
    success(res, data);
  } catch (err) {
    handleExternalError(err, res, next);
  }
});

/** GET /external/horoscope/signs — 十二星座码表 */
router.get('/external/horoscope/signs', async (_req, res, next) => {
  try {
    success(res, { items: listHoroscopeSigns() });
  } catch (err) {
    handleExternalError(err, res, next);
  }
});

/**
 * GET /external/horoscope?star=shuiping|水瓶座&scopes=all|day,week…
 * day 始终有；scopes 控制是否拉取明日/周/月/年（默认 all）
 */
router.get('/external/horoscope', async (req, res, next) => {
  try {
    const starRaw = typeof req.query.star === 'string' ? req.query.star : '';
    const dateRaw = typeof req.query.date === 'string' ? req.query.date : undefined;
    const data = await getHoroscope({
      star: starRaw,
      scopes: parseHoroscopeScopes(req.query.scopes),
      date: dateRaw,
    });
    success(res, data);
  } catch (err) {
    handleExternalError(err, res, next);
  }
});

export default router;
