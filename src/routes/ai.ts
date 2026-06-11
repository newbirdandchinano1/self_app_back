import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { success, fail } from '../utils/response.js';
import { AiScenarioError } from '../services/zhipu/scenarios.js';
import {
  analyzeAiFinanceDashboardFromText,
  analyzeCashFlowDashboardFromText,
  analyzeFinanceBillSummaryFromText,
  analyzeFinanceTxnCommentFromText,
  analyzeFoodNutritionFromImage,
  analyzeMemoReviewFromText,
  analyzeProjectTasksReviewFromText,
  analyzeUserSkillsPortfolioFromText,
  analyzeVisionWallGoalsFromText,
  analyzeWeaknessReviewFromText,
  analyzeWishItemAiCommentFromText,
  analyzeWishListRationalReviewFromText,
  estimateDailyIntakeTargetsFromContext,
  generateWeeklyReviewCoachingFromText,
  parseFinanceOneLinerFromImage,
  parseFinanceOneLinerFromText,
  parseFoodIntakeFromText,
  probeZhipuConnectivity,
} from '../services/zhipu/scenarios.js';

const router = Router();

function requireNonEmptyString(value: unknown, fieldName: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `${fieldName} 不能为空`;
  }
  return null;
}

function handleAiError(err: unknown, res: Parameters<typeof fail>[0], next: (err: unknown) => void) {
  if (err instanceof AiScenarioError) {
    return fail(res, err.message, -1, err.httpStatus);
  }
  next(err);
}

router.use(requireAuth);

router.get('/health', async (_req, res, next) => {
  try {
    const data = await probeZhipuConnectivity();
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/food/intake-from-text', async (req, res, next) => {
  try {
    const { text, question } = req.body ?? {};
    const textErr = requireNonEmptyString(text, 'text');
    if (textErr) return fail(res, textErr);

    const data = await parseFoodIntakeFromText(String(text), question ? String(question) : undefined);
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/food/nutrition-from-image', async (req, res, next) => {
  try {
    const { image_base64, image_mime_type, supplement_text } = req.body ?? {};
    const imageErr = requireNonEmptyString(image_base64, 'image_base64');
    if (imageErr) return fail(res, imageErr);

    const data = await analyzeFoodNutritionFromImage(
      String(image_base64),
      image_mime_type ? String(image_mime_type) : undefined,
      supplement_text ? String(supplement_text) : undefined,
    );
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/food/daily-targets', async (req, res, next) => {
  try {
    const { context_block } = req.body ?? {};
    const contextErr = requireNonEmptyString(context_block, 'context_block');
    if (contextErr) return fail(res, contextErr);

    const data = await estimateDailyIntakeTargetsFromContext(String(context_block));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/finance/parse-one-liner', async (req, res, next) => {
  try {
    const { text, accounts } = req.body ?? {};
    const textErr = requireNonEmptyString(text, 'text');
    if (textErr) return fail(res, textErr);

    const data = await parseFinanceOneLinerFromText(String(text), accounts);
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/finance/parse-one-liner-from-image', async (req, res, next) => {
  try {
    const { image_base64, image_mime_type, accounts } = req.body ?? {};
    const imageErr = requireNonEmptyString(image_base64, 'image_base64');
    if (imageErr) return fail(res, imageErr);

    const data = await parseFinanceOneLinerFromImage(
      String(image_base64),
      image_mime_type ? String(image_mime_type) : undefined,
      accounts,
    );
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/finance/txn-comment', async (req, res, next) => {
  try {
    const { summary_text } = req.body ?? {};
    const summaryErr = requireNonEmptyString(summary_text, 'summary_text');
    if (summaryErr) return fail(res, summaryErr);

    const data = await analyzeFinanceTxnCommentFromText(String(summary_text));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/finance/bill-summary-analysis', async (req, res, next) => {
  try {
    const { summary_text } = req.body ?? {};
    const summaryErr = requireNonEmptyString(summary_text, 'summary_text');
    if (summaryErr) return fail(res, summaryErr);

    const data = await analyzeFinanceBillSummaryFromText(String(summary_text));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/finance/dashboard-analysis', async (req, res, next) => {
  try {
    const { summary_text, past6_net_savings, past6_income } = req.body ?? {};
    const summaryErr = requireNonEmptyString(summary_text, 'summary_text');
    if (summaryErr) return fail(res, summaryErr);

    const data = await analyzeAiFinanceDashboardFromText(
      String(summary_text),
      Array.isArray(past6_net_savings) ? past6_net_savings : undefined,
      Array.isArray(past6_income) ? past6_income : undefined,
    );
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/finance/cash-flow-analysis', async (req, res, next) => {
  try {
    const { summary_text } = req.body ?? {};
    const summaryErr = requireNonEmptyString(summary_text, 'summary_text');
    if (summaryErr) return fail(res, summaryErr);

    const data = await analyzeCashFlowDashboardFromText(String(summary_text));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/wish-list/rational-review', async (req, res, next) => {
  try {
    const { context_text } = req.body ?? {};
    const contextErr = requireNonEmptyString(context_text, 'context_text');
    if (contextErr) return fail(res, contextErr);

    const data = await analyzeWishListRationalReviewFromText(String(context_text));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/wish-item/comment', async (req, res, next) => {
  try {
    const { summary_text } = req.body ?? {};
    const summaryErr = requireNonEmptyString(summary_text, 'summary_text');
    if (summaryErr) return fail(res, summaryErr);

    const data = await analyzeWishItemAiCommentFromText(String(summary_text));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/memo/review', async (req, res, next) => {
  try {
    const { memo_context_text } = req.body ?? {};
    const contextErr = requireNonEmptyString(memo_context_text, 'memo_context_text');
    if (contextErr) return fail(res, contextErr);

    const data = await analyzeMemoReviewFromText(String(memo_context_text));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/project/tasks-review', async (req, res, next) => {
  try {
    const { project_context_text } = req.body ?? {};
    const contextErr = requireNonEmptyString(project_context_text, 'project_context_text');
    if (contextErr) return fail(res, contextErr);

    const data = await analyzeProjectTasksReviewFromText(String(project_context_text));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/weakness/review', async (req, res, next) => {
  try {
    const { weakness_context_text } = req.body ?? {};
    const contextErr = requireNonEmptyString(weakness_context_text, 'weakness_context_text');
    if (contextErr) return fail(res, contextErr);

    const data = await analyzeWeaknessReviewFromText(String(weakness_context_text));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/weekly-review/coaching', async (req, res, next) => {
  try {
    const { user_prompt } = req.body ?? {};
    const promptErr = requireNonEmptyString(user_prompt, 'user_prompt');
    if (promptErr) return fail(res, promptErr);

    const data = await generateWeeklyReviewCoachingFromText(String(user_prompt));
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/vision-wall/assessment', async (req, res, next) => {
  try {
    const { user_display_name, plan_digest_text, expected_goal_ids } = req.body ?? {};
    const digestErr = requireNonEmptyString(plan_digest_text, 'plan_digest_text');
    if (digestErr) return fail(res, digestErr);
    if (!Array.isArray(expected_goal_ids) || expected_goal_ids.length === 0) {
      return fail(res, 'expected_goal_ids 必须为非空数组');
    }

    const goalIds = expected_goal_ids.map((id) => String(id)).filter(Boolean);
    if (goalIds.length === 0) {
      return fail(res, 'expected_goal_ids 必须包含有效 goal_id');
    }

    const data = await analyzeVisionWallGoalsFromText(
      String(plan_digest_text),
      goalIds,
      user_display_name ? String(user_display_name) : undefined,
    );
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

router.post('/skills/portfolio', async (req, res, next) => {
  try {
    const { user_display_name, lines } = req.body ?? {};
    const nameErr = requireNonEmptyString(user_display_name, 'user_display_name');
    if (nameErr) return fail(res, nameErr);
    if (!Array.isArray(lines) || lines.length === 0) {
      return fail(res, 'lines 必须为非空数组');
    }

    const normalizedLines = lines
      .map((line) => {
        if (!line || typeof line !== 'object') return null;
        const obj = line as Record<string, unknown>;
        const skillId = typeof obj.skill_id === 'string' ? obj.skill_id.trim() : '';
        if (!skillId) return null;
        return {
          skill_id: skillId,
          dimension: typeof obj.dimension === 'string' ? obj.dimension : '',
          name: typeof obj.name === 'string' ? obj.name : '',
          description: typeof obj.description === 'string' ? obj.description : '',
        };
      })
      .filter(Boolean) as Array<{
      skill_id: string;
      dimension: string;
      name: string;
      description: string;
    }>;

    if (normalizedLines.length === 0) {
      return fail(res, 'lines 中至少包含一条有效 skill_id');
    }

    const data = await analyzeUserSkillsPortfolioFromText(
      String(user_display_name),
      normalizedLines,
    );
    success(res, data);
  } catch (err) {
    handleAiError(err, res, next);
  }
});

export default router;
