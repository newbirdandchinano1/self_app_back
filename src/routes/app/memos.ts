import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import {
  MemoError,
  analyzeAndPersistMemoReview,
  createMemo,
  createMemoDimension,
  deleteMemo,
  deleteMemoDimension,
  getMemoDetail,
  listMemoDimensions,
  listMemos,
  listMemosByDimension,
  updateMemo,
  updateMemoDimension,
} from '../../services/memos.js';

const router = Router();

router.use(requireAuth);

function handleMemoError(
  err: unknown,
  res: Parameters<typeof fail>[0],
  next: (err: unknown) => void,
) {
  if (err instanceof MemoError) {
    return fail(res, err.message, -1, err.status);
  }
  next(err);
}

/** GET /memos/dimensions — 维度列表 */
router.get('/memos/dimensions', async (_req, res, next) => {
  try {
    const data = await listMemoDimensions();
    success(res, data);
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** POST /memos/dimensions — 新增备忘录维度 */
router.post('/memos/dimensions', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createMemoDimension({
      id: body.id,
      name: body.name,
      sort_order: body.sort_order,
    });
    success(res, data, '创建成功');
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** PATCH /memos/dimensions/:id — 修改备忘录维度 */
router.patch('/memos/dimensions/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateMemoDimension(String(req.params.id ?? ''), {
      name: body.name,
      sort_order: body.sort_order,
    });
    success(res, data, '更新成功');
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** DELETE /memos/dimensions/:id — 删除备忘录维度（软删，级联软删备忘） */
router.delete('/memos/dimensions/:id', async (req, res, next) => {
  try {
    const data = await deleteMemoDimension(String(req.params.id ?? ''));
    success(res, data, '删除成功');
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** GET /memos/dimensions/:dimensionId/items — 指定维度的备忘录列表 */
router.get('/memos/dimensions/:dimensionId/items', async (req, res, next) => {
  try {
    const data = await listMemosByDimension(String(req.params.dimensionId ?? ''));
    success(res, data);
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** GET /memos — 获取所有备忘录列表 */
router.get('/memos', async (_req, res, next) => {
  try {
    const data = await listMemos();
    success(res, data);
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** GET /memos/:id — 备忘录详情 */
router.get('/memos/:id', async (req, res, next) => {
  try {
    const data = await getMemoDetail(String(req.params.id ?? ''));
    success(res, data);
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** POST /memos — 新增备忘 */
router.post('/memos', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createMemo({
      id: body.id,
      title: body.title,
      body: body.body,
      dimension_id: body.dimension_id,
      linked_task_id: body.linked_task_id,
    });
    success(res, data, '创建成功');
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** PUT /memos/:id — 修改备忘 */
router.put('/memos/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateMemo(String(req.params.id ?? ''), {
      title: body.title,
      body: body.body,
      dimension_id: body.dimension_id,
      linked_task_id: body.linked_task_id,
    });
    success(res, data, '更新成功');
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** DELETE /memos/:id — 删除备忘（软删） */
router.delete('/memos/:id', async (req, res, next) => {
  try {
    const data = await deleteMemo(String(req.params.id ?? ''));
    success(res, data, '删除成功');
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/**
 * POST /memos/:id/ai-review — AI 分析备忘并存库
 * 复用 analyzeMemoReviewFromText，写入 ai_evaluation / ai_suggestions / ai_review_at
 * 纯分析不存库仍可用 POST /api/app/ai/memo/review
 */
router.post('/memos/:id/ai-review', async (req, res, next) => {
  try {
    const data = await analyzeAndPersistMemoReview(String(req.params.id ?? ''));
    success(res, data, '分析完成');
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

export default router;
