import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  adjustPoints,
  deletePointsLedgerEntry,
  getPointsBalance,
  listPointsLedgerHistory,
  PointsError,
  resetPoints,
} from '../../services/points.js';

const router = Router();

router.use(requireAuth);

const handlePointsError = createDomainErrorHandler(PointsError, { includeBodyExtras: true });

function parseDelta(body: Record<string, unknown>): number {
  const deltaRaw = body.delta;
  if (typeof deltaRaw === 'number') return deltaRaw;
  if (typeof deltaRaw === 'string') return Number(deltaRaw);
  return NaN;
}

async function handleAdjust(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await adjustPoints({
      delta: parseDelta(body),
      reason: typeof body.reason === 'string' ? body.reason : '',
      ref_type: typeof body.ref_type === 'string' ? body.ref_type : null,
      ref_id: typeof body.ref_id === 'string' ? body.ref_id : null,
      note: typeof body.note === 'string' ? body.note : null,
    });
    const { ok: _ok, ...data } = result;
    return success(res, data);
  } catch (err) {
    handlePointsError(err, res, next);
  }
}

async function handleBalance(
  _req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  try {
    const result = await getPointsBalance();
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

async function handleLedgerList(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  try {
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : Number(req.query.page);
    const limitRaw =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : Number(req.query.limit);
    const result = await listPointsLedgerHistory({
      page: Number.isFinite(pageRaw) ? pageRaw : 1,
      limit: Number.isFinite(limitRaw) ? limitRaw : 50,
    });
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

/** DELETE /points/ledger/:id — 仅路径参数删流水（不再支持 query/body id） */
async function handleLedgerDelete(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  try {
    const data = await deletePointsLedgerEntry(String(req.params.id ?? ''));
    return success(res, data);
  } catch (err) {
    handlePointsError(err, res, next);
  }
}

async function handleReset(
  _req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  try {
    const data = await resetPoints();
    return success(res, data);
  } catch (err) {
    handlePointsError(err, res, next);
  }
}

/**
 * 权威路径：/points/*
 * 旧路径 /wish-board/points/* 循环挂同一处理器（P1-03 / P1-09，无复制粘贴）。
 */
const POINTS_PREFIXES = ['/points', '/wish-board/points'] as const;

for (const prefix of POINTS_PREFIXES) {
  router.post(`${prefix}/adjust`, handleAdjust);
  router.get(`${prefix}/balance`, handleBalance);
  router.get(`${prefix}/ledger`, handleLedgerList);
  router.delete(`${prefix}/ledger/:id`, handleLedgerDelete);
  router.post(`${prefix}/reset`, handleReset);
}

export default router;
