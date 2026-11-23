import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  DevicePushTokenError,
  upsertDevicePushToken,
} from '../../services/device-push-tokens.js';
import {
  ReminderJobsError,
  putReminderJobs,
} from '../../services/reminder-jobs.js';
import {
  ReminderInboxError,
  listReminderInbox,
  markAllReminderInboxRead,
  markReminderInboxRead,
} from '../../services/reminder-inbox.js';
import { DEFAULT_SYNC_USER_ID } from '../../services/sync-change-log.js';

/**
 * 服务端提醒：push token / jobs / inbox。
 * 挂载前缀：/api/app
 * 单租户 user_id = default。
 */
const router = Router();

router.use(requireAuth);

const handlePushError = createDomainErrorHandler(DevicePushTokenError);
const handleJobsError = createDomainErrorHandler(ReminderJobsError);
const handleInboxError = createDomainErrorHandler(ReminderInboxError);

/** POST /push-tokens — 上报 Expo push token */
router.post('/push-tokens', async (req, res, next) => {
  try {
    const token =
      typeof req.body?.token === 'string'
        ? req.body.token
        : typeof req.body?.expoPushToken === 'string'
          ? req.body.expoPushToken
          : '';
    const platform =
      typeof req.body?.platform === 'string' ? req.body.platform : null;
    const data = await upsertDevicePushToken({
      userId: DEFAULT_SYNC_USER_ID,
      token,
      platform,
    });
    return success(res, data, '已登记推送 token');
  } catch (err) {
    handlePushError(err, res, next);
  }
});

/** PUT /reminder-jobs — 批量 upsert / cancel */
router.put('/reminder-jobs', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const data = await putReminderJobs({
      userId: DEFAULT_SYNC_USER_ID,
      upsert: Array.isArray(body.upsert) ? body.upsert : [],
      cancelDedupeKeys: Array.isArray(body.cancelDedupeKeys)
        ? body.cancelDedupeKeys
        : [],
      cancelPrefixes: Array.isArray(body.cancelPrefixes) ? body.cancelPrefixes : [],
      replaceCategories: Array.isArray(body.replaceCategories)
        ? body.replaceCategories
        : [],
    });
    return success(res, data);
  } catch (err) {
    handleJobsError(err, res, next);
  }
});

/** GET /reminder-inbox — 分页；支持 updatedSince */
router.get('/reminder-inbox', async (req, res, next) => {
  try {
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const updatedSince =
      typeof req.query.updatedSince === 'string' ? req.query.updatedSince : null;
    const limitRaw =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const data = await listReminderInbox({
      userId: DEFAULT_SYNC_USER_ID,
      cursor,
      updatedSince,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    });
    return success(res, data);
  } catch (err) {
    handleInboxError(err, res, next);
  }
});

/** POST /reminder-inbox/read-all */
router.post('/reminder-inbox/read-all', async (_req, res, next) => {
  try {
    const data = await markAllReminderInboxRead({ userId: DEFAULT_SYNC_USER_ID });
    return success(res, data, '已全部标为已读');
  } catch (err) {
    handleInboxError(err, res, next);
  }
});

/** POST /reminder-inbox/read — body: { id? , dedupeKey? } */
router.post('/reminder-inbox/read', async (req, res, next) => {
  try {
    const id = typeof req.body?.id === 'string' ? req.body.id : null;
    const dedupeKey =
      typeof req.body?.dedupeKey === 'string' ? req.body.dedupeKey : null;
    if (!id && !dedupeKey) return fail(res, '缺少 id 或 dedupeKey', -1, 400);
    const data = await markReminderInboxRead({
      userId: DEFAULT_SYNC_USER_ID,
      id,
      dedupeKey,
    });
    return success(res, data, '已标为已读');
  } catch (err) {
    handleInboxError(err, res, next);
  }
});

/** POST /reminder-inbox/:id/read */
router.post('/reminder-inbox/:id/read', async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '').trim();
    if (!id) return fail(res, '缺少提醒 id', -1, 400);
    const data = await markReminderInboxRead({
      userId: DEFAULT_SYNC_USER_ID,
      id,
    });
    return success(res, data, '已标为已读');
  } catch (err) {
    handleInboxError(err, res, next);
  }
});

export default router;
