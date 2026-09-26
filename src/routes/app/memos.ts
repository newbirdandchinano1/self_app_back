import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  MemoError,
  analyzeAndPersistMemoReview,
  createMemo,
  deleteMemo,
  getMemoDetail,
  listMemos,
  updateMemo,
} from '../../services/memos.js';

const router = Router();

router.use(requireAuth);

const handleMemoError = createDomainErrorHandler(MemoError);

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
      linked_task_id: body.linked_task_id,
      is_pinned: body.is_pinned,
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
      linked_task_id: body.linked_task_id,
      is_pinned: body.is_pinned,
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
