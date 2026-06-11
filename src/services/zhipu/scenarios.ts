import {
  analyzeAiFinanceDashboardFromText as analyzeAiFinanceDashboardFromTextCore,
  analyzeCashFlowDashboardFromText as analyzeCashFlowDashboardFromTextCore,
  analyzeFinanceBillSummaryFromText as analyzeFinanceBillSummaryFromTextCore,
  analyzeFinanceTxnCommentFromText as analyzeFinanceTxnCommentFromTextCore,
  analyzeFoodNutritionFromImage as analyzeFoodNutritionFromImageCore,
  analyzeMemoReviewFromText as analyzeMemoReviewFromTextCore,
  analyzeProjectTasksReviewFromText as analyzeProjectTasksReviewFromTextCore,
  analyzeUserSkillsPortfolioFromText as analyzeUserSkillsPortfolioFromTextCore,
  analyzeVisionWallGoalsFromText as analyzeVisionWallGoalsFromTextCore,
  analyzeWeaknessReviewFromText as analyzeWeaknessReviewFromTextCore,
  analyzeWishItemAiCommentFromText as analyzeWishItemAiCommentFromTextCore,
  analyzeWishListRationalReviewFromText as analyzeWishListRationalReviewFromTextCore,
  estimateDailyIntakeTargetsFromContext as estimateDailyIntakeTargetsFromContextCore,
  generateWeeklyReviewCoachingFromText as generateWeeklyReviewCoachingFromTextCore,
  getZhipuApiKey,
  parseFinanceOneLinerFromImage as parseFinanceOneLinerFromImageCore,
  parseFinanceOneLinerFromText as parseFinanceOneLinerFromTextCore,
  parseFoodIntakeFromText as parseFoodIntakeFromTextCore,
  probeZhipuTextConnectivity,
} from './zhipu-image-parse.js';

export class AiScenarioError extends Error {
  constructor(
    message: string,
    public readonly httpStatus = 502,
  ) {
    super(message);
    this.name = 'AiScenarioError';
  }
}

type OkResult = { ok: true };
type FailResult = { ok: false; error?: string; httpStatus?: number };

function requireOk<T extends OkResult | FailResult>(
  result: T,
): Extract<T, OkResult> {
  if (!result.ok) {
    throw new AiScenarioError(result.error || 'AI 请求失败', result.httpStatus ?? 502);
  }
  return result as Extract<T, OkResult>;
}

function apiKey(): string {
  return getZhipuApiKey();
}

function toImageDataUri(base64: string, mimeType = 'image/jpeg'): string {
  const normalized = base64.replace(/^data:[^;]+;base64,/, '').trim();
  return `data:${mimeType};base64,${normalized}`;
}

export async function parseFoodIntakeFromText(text: string, question?: string) {
  const result = requireOk(
    await parseFoodIntakeFromTextCore({ apiKey: apiKey(), text, question }),
  );
  return result.data;
}

export async function analyzeFoodNutritionFromImage(
  imageBase64: string,
  imageMimeType?: string,
  supplementText?: string,
) {
  const result = requireOk(
    await analyzeFoodNutritionFromImageCore({
      apiKey: apiKey(),
      imageBase64,
      imageMimeType,
      supplementText,
    }),
  );
  return result.data;
}

export async function estimateDailyIntakeTargetsFromContext(contextBlock: string) {
  const result = requireOk(
    await estimateDailyIntakeTargetsFromContextCore({
      apiKey: apiKey(),
      contextBlock,
    }),
  );
  return result.data;
}

export async function parseFinanceOneLinerFromText(
  text: string,
  accounts?: Array<{ name: string; account_no?: string }>,
) {
  const result = requireOk(
    await parseFinanceOneLinerFromTextCore({ apiKey: apiKey(), text, accounts }),
  );
  return {
    transaction_type: result.transaction_type,
    amount: result.amount,
    name: result.name,
    category_label: result.category_label,
    payment_account_label: result.payment_account_label,
    account_name: result.account_name,
  };
}

export async function parseFinanceOneLinerFromImage(
  imageBase64: string,
  imageMimeType?: string,
  accounts?: Array<{ name: string; account_no?: string }>,
) {
  const result = await parseFinanceOneLinerFromImageCore({
    apiKey: apiKey(),
    imageDataUri: toImageDataUri(imageBase64, imageMimeType || 'image/jpeg'),
    accounts,
  });
  if (!result.ok) {
    throw new AiScenarioError(result.error || 'AI 请求失败', result.httpStatus ?? 502);
  }
  return {
    transaction_type: result.transaction_type,
    amount: result.amount,
    name: result.name,
    category_label: result.category_label,
    payment_account_label: result.payment_account_label,
    account_name: result.account_name,
    is_bill: true,
  };
}

export async function analyzeFinanceTxnCommentFromText(summaryText: string) {
  const result = requireOk(
    await analyzeFinanceTxnCommentFromTextCore({ apiKey: apiKey(), summaryText }),
  );
  return { comment: result.comment };
}

export async function analyzeFinanceBillSummaryFromText(summaryText: string) {
  const result = requireOk(
    await analyzeFinanceBillSummaryFromTextCore({ apiKey: apiKey(), summaryText }),
  );
  return { analysis: result.analysis };
}

export async function analyzeAiFinanceDashboardFromText(
  summaryText: string,
  past6NetSavings?: number[],
  past6Income?: number[],
) {
  const result = requireOk(
    await analyzeAiFinanceDashboardFromTextCore({
      apiKey: apiKey(),
      summaryText,
      past6NetSavings,
      past6Income,
    }),
  );
  return result.data;
}

export async function analyzeCashFlowDashboardFromText(summaryText: string) {
  const result = requireOk(
    await analyzeCashFlowDashboardFromTextCore({ apiKey: apiKey(), summaryText }),
  );
  return { analysis: result.analysis };
}

export async function analyzeWishListRationalReviewFromText(contextText: string) {
  const result = requireOk(
    await analyzeWishListRationalReviewFromTextCore({ apiKey: apiKey(), contextText }),
  );
  return { headline: result.headline, review: result.review };
}

export async function analyzeWishItemAiCommentFromText(summaryText: string) {
  const result = requireOk(
    await analyzeWishItemAiCommentFromTextCore({ apiKey: apiKey(), summaryText }),
  );
  return { comment: result.comment };
}

export async function analyzeMemoReviewFromText(memoContextText: string) {
  const result = requireOk(
    await analyzeMemoReviewFromTextCore({ apiKey: apiKey(), memoContextText }),
  );
  return { evaluation: result.evaluation, suggestions: result.suggestions };
}

export async function analyzeProjectTasksReviewFromText(projectContextText: string) {
  const result = requireOk(
    await analyzeProjectTasksReviewFromTextCore({ apiKey: apiKey(), projectContextText }),
  );
  return { evaluation: result.evaluation, suggestions: result.suggestions };
}

export async function analyzeWeaknessReviewFromText(weaknessContextText: string) {
  const result = requireOk(
    await analyzeWeaknessReviewFromTextCore({ apiKey: apiKey(), weaknessContextText }),
  );
  return { evaluation: result.evaluation, suggestions: result.suggestions };
}

export async function generateWeeklyReviewCoachingFromText(userPrompt: string) {
  const result = requireOk(
    await generateWeeklyReviewCoachingFromTextCore({ apiKey: apiKey(), userPrompt }),
  );
  return { text: result.text };
}

export async function analyzeVisionWallGoalsFromText(
  planDigestText: string,
  expectedGoalIds: string[],
  userDisplayName?: string,
) {
  const result = requireOk(
    await analyzeVisionWallGoalsFromTextCore({
      apiKey: apiKey(),
      planDigestText,
      expectedGoalIds,
      userDisplayName,
    }),
  );
  return result.data;
}

export async function analyzeUserSkillsPortfolioFromText(
  userDisplayName: string,
  lines: Array<{ skill_id: string; dimension: string; name: string; description: string }>,
) {
  const result = requireOk(
    await analyzeUserSkillsPortfolioFromTextCore({
      apiKey: apiKey(),
      userDisplayName,
      lines,
    }),
  );
  return result.data;
}

export async function probeZhipuConnectivity() {
  const started = Date.now();
  const result = await probeZhipuTextConnectivity(apiKey());
  if (!result.httpOk) {
    throw new AiScenarioError(
      result.bodySnippet || '智谱连通性探测失败',
      result.httpStatus || 502,
    );
  }
  return {
    ok: true,
    model: 'glm-4-flash',
    latency_ms: Date.now() - started,
  };
}
