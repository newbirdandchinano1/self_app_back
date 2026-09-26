import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { AiScenarioError } from '../../services/zhipu/scenarios.js';
import {
  analyzeAiFinanceDashboardFromText,
  analyzeCashFlowDashboardFromText,
  analyzeFinanceBillSummaryFromText,
  analyzeFinanceTxnCommentFromText,
  analyzeFoodNutritionFromImage,
  analyzeMemoReviewFromText,
  estimateDailyIntakeTargetsFromContext,
  generateWeeklyReviewCoachingFromText,
  parseFinanceOneLinerFromImage,
  parseFinanceOneLinerFromText,
  parseFoodIntakeFromText,
  probeZhipuConnectivity,
} from '../../services/zhipu/scenarios.js';

const router = Router();

function requireNonEmptyString(value: unknown, fieldName: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `${fieldName} 不能为空`;
  }
  return null;
}

const handleAiError = createDomainErrorHandler(AiScenarioError, { statusKey: 'httpStatus' });

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

export default router;
