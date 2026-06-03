/**
 * 智谱 GLM 视觉模型：图片 → JSON（chat/completions）
 * 默认密钥内置在应用中；若设置了 EXPO_PUBLIC_ZHIPU_API_KEY 则优先使用该环境变量（便于轮换而无需改代码）。
 */

const ZHIPU_EMBEDDED_API_KEY = 'd0ab5a5e402040d291d9b77f58996d32.nL1sXtGfaUMXzW7W';

const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

/** 智谱 GLM-4-Flash（chat/completions 的 model 字段） */
const ZHIPU_GLM_4_FLASH_MODEL = 'glm-4-flash';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 每次智谱请求结束后的随机间隔（毫秒），降低触发限流概率 */
function zhipuPostRequestCooldownMs(): number {
  return 200 + Math.floor(Math.random() * 101);
}

let zhipuChatRequestTail: Promise<void> = Promise.resolve();

/**
 * 智谱 chat/completions 全局串行：任意时刻仅一条 HTTP 在途；每次调用结束后随机 sleep 200–300ms 再允许下一条。
 */
function runZhipuChatExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = (async (): Promise<T> => {
    await zhipuChatRequestTail;
    try {
      return await fn();
    } finally {
      await sleep(zhipuPostRequestCooldownMs());
    }
  })();
  zhipuChatRequestTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const DEFAULT_JSON_TEMPLATE = `{
  "result": {
    "total_amount": 0,
    "date": "",
    "items": [{"name": "", "price": 0}],
    "is_valid": true
  }
}`;

export type ParseImageToJsonOptions = {
  apiKey: string;
  imageBase64: string;
  /** 不含 data: 前缀的纯 base64 时，由调用方指定 MIME，默认 image/jpeg */
  imageMimeType?: string;
  question?: string;
  jsonTemplate?: string;
};

export type ParseImageToJsonResult =
  | { ok: true; data: unknown; rawContent: string }
  | { ok: false; error: string; httpStatus?: number; details?: unknown };

export async function parseImageToJson(options: ParseImageToJsonOptions): Promise<ParseImageToJsonResult> {
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥' };
  }

  const question = (options.question ?? '分析这张图片').trim() || '分析这张图片';
  const mime = (options.imageMimeType ?? 'image/jpeg').trim() || 'image/jpeg';
  const jsonTemplate = (options.jsonTemplate ?? DEFAULT_JSON_TEMPLATE).trim();

  const systemContent = `你是一个图片解析工具。严格按照以下规则输出：
1. 只返回一个标准JSON对象
2. 完全遵循我给你的JSON格式和字段类型
3. 不要添加任何JSON以外的内容（包括解释、说明、代码块）
4. 如果无法识别某个字段，填null或默认值

必须严格遵循的JSON格式：
${jsonTemplate}`;

  try {
    const dr = await dispatchZhipuVisionChat({
      apiKey: key,
      systemContent,
      userText: question,
      imageBase64: options.imageBase64,
      imageMimeType: mime,
      temperature: 0.1,
      maxTokens: 4096,
      maxAttempts: 8,
      retryDelayMs: 1000,
      forceJsonObject: true,
    });

    if (!dr.ok) {
      return { ok: false, error: dr.error, httpStatus: dr.httpStatus, details: dr.details };
    }

    const content = dr.text.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownJsonFence(content));
    } catch {
      return {
        ok: false,
        error: '模型返回的不是合法 JSON',
        httpStatus: dr.httpStatus,
        details: { contentSnippet: content.slice(0, 500) },
      };
    }

    return { ok: true, data: parsed, rawContent: content };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `网络或解析异常: ${message}` };
  }
}

export function getZhipuApiKeyFromEnv(): string {
  if (typeof process === 'undefined') return '';
  return (
    process.env.ZHIPU_API_KEY ??
    process.env.EXPO_PUBLIC_ZHIPU_API_KEY ??
    ''
  ).trim();
}

/** 环境变量优先，否则使用应用内置密钥 */
export function getZhipuApiKey(): string {
  return getZhipuApiKeyFromEnv() || ZHIPU_EMBEDDED_API_KEY;
}

export type ZhipuConnectivityProbeResult = {
  httpStatus: number;
  httpOk: boolean;
  bodySnippet: string;
};

/** 最小文本請求，用於「我的」頁連通性測試（顯示原始 JSON）。 */
export async function probeZhipuTextConnectivity(apiKey: string): Promise<ZhipuConnectivityProbeResult> {
  const key = apiKey.trim();
  if (!key) {
    return { httpStatus: 0, httpOk: false, bodySnippet: '未配置 API 金鑰' };
  }
  const payload = JSON.stringify({
    model: ZHIPU_GLM_4_FLASH_MODEL,
    messages: [{ role: 'user', content: '只回复这两个字母：OK' }],
    max_tokens: 32,
    temperature: 0,
  });
  try {
    const response = await runZhipuChatExclusive(() =>
      fetch(ZHIPU_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: payload,
      }),
    );
    const raw = await response.text();
    return {
      httpStatus: response.status,
      httpOk: response.ok,
      bodySnippet: raw.length > 2400 ? `${raw.slice(0, 2400)}…` : raw,
    };
  } catch (e) {
    return {
      httpStatus: 0,
      httpOk: false,
      bodySnippet: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 当前 AI 引擎（智谱）API Key。 */
export function getActiveAiLlmApiKey(): string {
  return getZhipuApiKey();
}

export function isActiveAiLlmConfigured(): boolean {
  return Boolean(getActiveAiLlmApiKey().trim());
}

type DispatchTextChatOk = { ok: true; text: string; attempts: number; httpStatus: number };
type DispatchTextChatFail = {
  ok: false;
  error: string;
  attempts: number;
  httpStatus?: number;
  details?: unknown;
};
type DispatchTextChatResult = DispatchTextChatOk | DispatchTextChatFail;

/** 文本 chat：智谱 glm-4-flash；`forceJsonObject` 时加 `response_format`。 */
async function dispatchZhipuTextChat(options: {
  apiKey: string;
  systemContent: string;
  userContent: string;
  temperature: number;
  maxTokens: number;
  maxAttempts: number;
  retryDelayMs: number;
  forceJsonObject: boolean;
}): Promise<DispatchTextChatResult> {
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }

  const payloadObj: Record<string, unknown> = {
    model: ZHIPU_GLM_4_FLASH_MODEL,
    messages: [
      { role: 'system', content: options.systemContent },
      { role: 'user', content: options.userContent },
    ],
    temperature: options.temperature,
    max_tokens: options.maxTokens,
  };
  if (options.forceJsonObject) {
    payloadObj.response_format = { type: 'json_object' };
  }
  const payload = JSON.stringify(payloadObj);

  let lastError = '未知错误';
  let lastHttp = 0;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await runZhipuChatExclusive(() =>
        fetch(ZHIPU_CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: payload,
        }),
      );
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        attempts: attempt,
        httpStatus: 0,
      };
    }

    const httpStatus = response.status;
    lastHttp = httpStatus;
    const rawText = await response.text();
    let body: unknown = rawText;
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      body = rawText;
    }

    if (bodyIndicatesZhipu1305(body) && attempt < options.maxAttempts) {
      await sleep(options.retryDelayMs);
      continue;
    }

    if (!response.ok) {
      const msg =
        typeof body === 'object' && body !== null && 'error' in body
          ? String((body as { error?: { message?: string } }).error?.message ?? response.statusText)
          : response.statusText;
      lastError = msg;
      if (bodyIndicatesZhipu1305(body) && attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus, details: body };
    }

    const content = extractMessageContentFromZhipuBody(body);
    if (!content) {
      lastError = '响应中无有效 content';
      if (bodyIndicatesZhipu1305(body) && attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      if (attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus, details: body };
    }

    return { ok: true, text: content, attempts: attempt, httpStatus };
  }

  return { ok: false, error: lastError, attempts: options.maxAttempts, httpStatus: lastHttp };
}

type DispatchVisionChatOk = { ok: true; text: string; attempts: number; httpStatus: number };
type DispatchVisionChatFail = {
  ok: false;
  error: string;
  attempts: number;
  httpStatus?: number;
  details?: unknown;
};
type DispatchVisionChatResult = DispatchVisionChatOk | DispatchVisionChatFail;

/** 视觉：智谱 glm-4.6v-flash（识图）。 */
async function dispatchZhipuVisionChat(options: {
  apiKey: string;
  systemContent: string;
  userText: string;
  imageBase64: string;
  imageMimeType: string;
  temperature: number;
  maxTokens: number;
  maxAttempts: number;
  retryDelayMs: number;
  forceJsonObject: boolean;
  /** 智谱视觉模型 id */
  zhipuVisionModel?: string;
}): Promise<DispatchVisionChatResult> {
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const mime = (options.imageMimeType ?? 'image/jpeg').trim() || 'image/jpeg';
  const rawB64 = options.imageBase64?.trim() ?? '';
  if (!rawB64) {
    return { ok: false, error: '图片数据为空', attempts: 0 };
  }

  const dataUrl = mime.includes('/') ? `data:${mime};base64,${rawB64}` : `data:image/jpeg;base64,${rawB64}`;
  const zhipuModel = options.zhipuVisionModel ?? 'glm-4.6v-flash';
  const payloadObj: Record<string, unknown> = {
    model: zhipuModel,
    temperature: options.temperature,
    messages: [
      { role: 'system', content: options.systemContent },
      {
        role: 'user',
        content: [
          { type: 'text', text: options.userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: options.maxTokens,
  };
  if (options.forceJsonObject) {
    payloadObj.response_format = { type: 'json_object' };
  }
  const payload = JSON.stringify(payloadObj);

  let lastError = '未知错误';
  let lastHttp = 0;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await runZhipuChatExclusive(() =>
        fetch(ZHIPU_CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: payload,
        }),
      );
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        attempts: attempt,
        httpStatus: 0,
      };
    }

    const httpStatus = response.status;
    lastHttp = httpStatus;
    const rawText = await response.text();
    let body: unknown = rawText;
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      body = rawText;
    }

    if (bodyIndicatesZhipu1305(body) && attempt < options.maxAttempts) {
      await sleep(options.retryDelayMs);
      continue;
    }

    if (!response.ok) {
      const msg =
        typeof body === 'object' && body !== null && 'error' in body
          ? String((body as { error?: { message?: string } }).error?.message ?? response.statusText)
          : response.statusText;
      lastError = msg;
      if (bodyIndicatesZhipu1305(body) && attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus, details: body };
    }

    const content = extractMessageContentFromZhipuBody(body);
    if (!content) {
      lastError = '响应中无有效 content';
      if (bodyIndicatesZhipu1305(body) && attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      if (attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus, details: body };
    }

    return { ok: true, text: content, attempts: attempt, httpStatus };
  }

  return { ok: false, error: lastError, attempts: options.maxAttempts, httpStatus: lastHttp };
}

type LoopTextJsonFinish<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; details?: unknown };

/**
 * 文本 JSON：外层重试（智谱 1305 与 JSON 解析失败），每次请求内为单轮 dispatch。
 */
async function loopTextJsonLlmWithRetries<T>(options: {
  apiKey: string;
  systemContent: string;
  userContent: string;
  temperature: number;
  maxTokens: number;
  maxAttempts: number;
  retryDelayMs: number;
  finish: (parsed: unknown, rawText: string, attempt: number) => LoopTextJsonFinish<T>;
}): Promise<
  | { ok: true; value: T; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown }
> {
  let lastError = '未知错误';
  let lastHttp = 0;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const dr = await dispatchZhipuTextChat({
      apiKey: options.apiKey,
      systemContent: options.systemContent,
      userContent: options.userContent,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      maxAttempts: 1,
      retryDelayMs: 0,
      forceJsonObject: true,
    });
    if (!dr.ok) {
      lastError = dr.error;
      lastHttp = dr.httpStatus ?? 0;
      const retryable = bodyIndicatesZhipu1305(dr.details);
      if (retryable && attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: lastHttp, details: dr.details };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownJsonFence(dr.text)) as unknown;
    } catch {
      lastError = '模型返回的不是合法 JSON';
      if (attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return {
        ok: false,
        error: lastError,
        attempts: attempt,
        httpStatus: dr.httpStatus,
        details: { snippet: dr.text.slice(0, 400) },
      };
    }
    const fin = options.finish(parsed, dr.text.trim(), attempt);
    if (fin.ok) {
      return { ok: true, value: fin.value, rawContent: dr.text.trim(), attempts: attempt };
    }
    lastError = fin.error;
    if (attempt < options.maxAttempts) {
      await sleep(options.retryDelayMs);
      continue;
    }
    return { ok: false, error: lastError, attempts: attempt, httpStatus: dr.httpStatus, details: fin.details };
  }
  return { ok: false, error: lastError, attempts: options.maxAttempts, httpStatus: lastHttp };
}

type LoopVisionJsonFinish<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; details?: unknown };

/** 视觉 JSON：与 `loopTextJsonLlmWithRetries` 同理，走识图模型。 */
async function loopVisionJsonLlmWithRetries<T>(options: {
  apiKey: string;
  systemContent: string;
  userText: string;
  imageBase64: string;
  imageMimeType: string;
  temperature: number;
  maxTokens: number;
  maxAttempts: number;
  retryDelayMs: number;
  zhipuVisionModel?: string;
  finish: (parsed: unknown, rawText: string, attempt: number) => LoopVisionJsonFinish<T>;
}): Promise<
  | { ok: true; value: T; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown }
> {
  let lastError = '未知错误';
  let lastHttp = 0;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const dr = await dispatchZhipuVisionChat({
      apiKey: options.apiKey,
      systemContent: options.systemContent,
      userText: options.userText,
      imageBase64: options.imageBase64,
      imageMimeType: options.imageMimeType,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      maxAttempts: 1,
      retryDelayMs: 0,
      forceJsonObject: true,
      zhipuVisionModel: options.zhipuVisionModel,
    });
    if (!dr.ok) {
      lastError = dr.error;
      lastHttp = dr.httpStatus ?? 0;
      const retryable = bodyIndicatesZhipu1305(dr.details);
      if (retryable && attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: lastHttp, details: dr.details };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownJsonFence(dr.text)) as unknown;
    } catch {
      lastError = '模型返回的不是合法 JSON';
      if (attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return {
        ok: false,
        error: lastError,
        attempts: attempt,
        httpStatus: dr.httpStatus,
        details: { snippet: dr.text.slice(0, 400) },
      };
    }
    const fin = options.finish(parsed, dr.text.trim(), attempt);
    if (fin.ok) {
      return { ok: true, value: fin.value, rawContent: dr.text.trim(), attempts: attempt };
    }
    lastError = fin.error;
    if (attempt < options.maxAttempts) {
      await sleep(options.retryDelayMs);
      continue;
    }
    return { ok: false, error: lastError, attempts: attempt, httpStatus: dr.httpStatus, details: fin.details };
  }
  return { ok: false, error: lastError, attempts: options.maxAttempts, httpStatus: lastHttp };
}

/** 纯文本（无 JSON 约束），用于每周复盘教练等。 */
async function loopPlainTextLlmWithRetries(options: {
  apiKey: string;
  systemContent: string;
  userContent: string;
  temperature: number;
  maxTokens: number;
  maxAttempts: number;
  retryDelayMs: number;
}): Promise<
  | { ok: true; text: string; attempts: number; httpStatus: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown }
> {
  let lastError = '未知错误';
  let lastHttp = 0;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const dr = await dispatchZhipuTextChat({
      apiKey: options.apiKey,
      systemContent: options.systemContent,
      userContent: options.userContent,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      maxAttempts: 1,
      retryDelayMs: 0,
      forceJsonObject: false,
    });
    if (!dr.ok) {
      lastError = dr.error;
      lastHttp = dr.httpStatus ?? 0;
      const retryable = bodyIndicatesZhipu1305(dr.details);
      if (retryable && attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: lastHttp, details: dr.details };
    }
    const t = dr.text.trim();
    if (!t) {
      lastError = '响应中无有效文本';
      if (attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: dr.httpStatus };
    }
    return { ok: true, text: t, attempts: attempt, httpStatus: dr.httpStatus };
  }
  return { ok: false, error: lastError, attempts: options.maxAttempts, httpStatus: lastHttp };
}

/** 纯文字描述一餐 → 估算蛋白质、碳水、钠与「应计入」的水分（毫升） */
export type FoodTextIntakeJson = {
  food_summary: string;
  hydration_ml: number;
  protein_g: number;
  carbohydrate_g: number;
  sodium_mg: number;
  /** 120～400 字结构化中文点评（识别概要、营养结构、均衡注意、可行建议） */
  ai_evaluation: string;
};

export type ParseFoodIntakeFromTextOptions = {
  apiKey: string;
  text: string;
  /** 默认：分析这段饮食描述并估算营养 */
  question?: string;
};

export type ParseFoodIntakeFromTextResult =
  | { ok: true; data: FoodTextIntakeJson; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

/** 文字/拍照摄入写入 intake_ai_comment 的 ai_evaluation 字段写作要求 */
const FOOD_INTAKE_AI_EVALUATION_GUIDE = `ai_evaluation 写作要求（必填且须充实）：
- 简体中文，总字数建议 120～400 字，至少 4 句完整表述；禁止仅用一两句敷衍。
- 自然段书写，不要用 markdown、编号列表或 JSON 嵌套。
- 须依次涵盖（可写成连贯段落，用小标题感弱衔接即可）：
  (1) 识别概要：本餐/图中主要食物、烹饪方式与可见份量或搭配特点；
  (2) 营养结构：蛋白质、碳水、脂肪与钠盐的大致倾向（定性即可，勿大段复读数值字段）；
  (3) 均衡与注意点：蔬菜、优质蛋白、精制碳水、油盐糖、膳食纤维等 1～2 条具体评价；
  (4) 可行建议：针对本餐给出 1～2 条可执行的微调或下一餐搭配建议。
- 语气亲切、像注册营养师口语点评；勿编造用户未提供的信息；勿做疾病诊断、用药或极端节食建议。`;

const FOOD_TEXT_INTAKE_JSON_TEMPLATE = `{
  "result": {
    "food_summary": "",
    "hydration_ml": 0,
    "protein_g": 0,
    "carbohydrate_g": 0,
    "sodium_mg": 0,
    "ai_evaluation": ""
  }
}`;

function normalizeFoodTextIntakeFromResult(raw: unknown): FoodTextIntakeJson {
  const empty: FoodTextIntakeJson = {
    food_summary: '',
    hydration_ml: 0,
    protein_g: 0,
    carbohydrate_g: 0,
    sodium_mg: 0,
    ai_evaluation: '',
  };
  if (typeof raw !== 'object' || raw === null) return empty;
  const root = raw as Record<string, unknown>;
  const r = root.result;
  if (typeof r !== 'object' || r === null) return empty;
  const o = r as Record<string, unknown>;
  const summary =
    typeof o.food_summary === 'string'
      ? o.food_summary.trim()
      : o.food_summary != null
        ? String(o.food_summary).trim()
        : '';
  const evalRaw = o.ai_evaluation;
  const ai_evaluation =
    typeof evalRaw === 'string'
      ? evalRaw.trim()
      : evalRaw != null
        ? String(evalRaw).trim()
        : '';
  return {
    food_summary: summary,
    hydration_ml: toNonNegativeFiniteNumber(o.hydration_ml),
    protein_g: toNonNegativeFiniteNumber(o.protein_g),
    carbohydrate_g: toNonNegativeFiniteNumber(o.carbohydrate_g),
    sodium_mg: toNonNegativeFiniteNumber(o.sodium_mg),
    ai_evaluation,
  };
}

/**
 * 根据用户中文饮食描述估算 hydration_ml、protein_g、carbohydrate_g、sodium_mg。
 * hydration_ml 仅计汤/粥/饮料/水果等；正餐固体不显性计水（见系统提示）。
 * 含 1305 重试与 JSON 围栏剥离。
 */
export async function parseFoodIntakeFromText(
  options: ParseFoodIntakeFromTextOptions,
): Promise<ParseFoodIntakeFromTextResult> {
  const maxAttempts = 40;
  const retryDelayMs = 1000;
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.text.trim();
  if (!text) {
    return { ok: false, error: '描述为空', attempts: 0 };
  }
  const question = (
    options.question ??
    '请完整分析这段饮食描述：估算营养数值，并输出充实的 food_summary 与 ai_evaluation'
  ).trim();

  const systemContent = `只返回严格JSON，不要任何解释和markdown（含代码块）。顶层为一个对象，且必须包含 result；result 内字段：food_summary、hydration_ml、protein_g、carbohydrate_g、sodium_mg、ai_evaluation。

- food_summary：1～2 句中文，概括所吃所喝、大致份量与烹饪或搭配特点（约 30～80 字，勿仅写菜名罗列）。

hydration_ml（毫升，非负）的计入规则（必须遵守）：
- **应计入**：用户明确提到的汤、羹、粥、饮品（水、茶、咖啡、奶茶、果汁、汽水、酒等）、牛奶/豆浆等流质、以及**水果**中可视为饮水的部分（可用常见经验估算，如一个中等苹果约对应少量水等，合理即可）。
- **严禁计入**：米饭、面条、馒头、面包、炒菜、炖肉、烧烤、点心等**正餐固体食物**内部的隐性水分（菜肴「自带」的水、油焖蒸发的水等一律不要折算进 hydration_ml）。若描述里只有这类正餐、没有任何汤粥饮料水果等可饮水来源，则 hydration_ml 必须为 0。
- protein_g、carbohydrate_g、sodium_mg 为非负数值，无法从描述推断时填 0。

${FOOD_INTAKE_AI_EVALUATION_GUIDE}

必须遵循的形状：
${FOOD_TEXT_INTAKE_JSON_TEMPLATE}`;

  let lastError = '未知错误';
  let lastHttp = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const dr = await dispatchZhipuTextChat({
      apiKey: key,
      systemContent,
      userContent: `${question}：${text}`,
      temperature: 0.0,
      maxTokens: 2048,
      maxAttempts: 1,
      retryDelayMs: 0,
      forceJsonObject: true,
    });

    if (!dr.ok) {
      lastError = dr.error;
      lastHttp = dr.httpStatus ?? 0;
      const retryable = bodyIndicatesZhipu1305(dr.details);
      if (retryable && attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: lastHttp, details: dr.details };
    }

    const content = dr.text.trim();
    let parsed: unknown;
    try {
      const cleaned = stripMarkdownJsonFence(content);
      parsed = JSON.parse(cleaned) as unknown;
    } catch {
      lastError = '模型返回的不是合法 JSON';
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: dr.httpStatus, details: { snippet: content.slice(0, 400) } };
    }

    const data = normalizeFoodTextIntakeFromResult(parsed);
    return { ok: true, data, rawContent: content, attempts: attempt };
  }

  return { ok: false, error: lastError, attempts: maxAttempts, httpStatus: lastHttp };
}

/** 首页「智能建议」：结合用户档案与摄入摘要，估算当日四项摄入目标 */
export type DailyIntakeTargetsEstimateJson = {
  hydration_ml: number;
  protein_g: number;
  carbohydrate_g: number;
  sodium_mg: number;
  /** 1～2 句中文，说明主要调整依据（勿编造未提供的数据） */
  rationale_zh?: string;
};

export type EstimateDailyIntakeTargetsFromContextOptions = {
  apiKey: string;
  /** 由调用方组装的用户档案、近7日摄入与本地公式参考值（中文） */
  contextBlock: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type EstimateDailyIntakeTargetsFromContextResult =
  | { ok: true; data: DailyIntakeTargetsEstimateJson; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function clampDailyIntakeTargetsEstimate(raw: DailyIntakeTargetsEstimateJson): DailyIntakeTargetsEstimateJson {
  const clamp = (n: number, lo: number, hi: number) => {
    if (!Number.isFinite(n)) return lo;
    return Math.round(Math.min(hi, Math.max(lo, n)));
  };
  let rationale = typeof raw.rationale_zh === 'string' ? raw.rationale_zh.trim() : '';
  if (rationale.length > 400) rationale = `${rationale.slice(0, 400)}…`;
  return {
    hydration_ml: clamp(raw.hydration_ml, 800, 5000),
    protein_g: clamp(raw.protein_g, 35, 220),
    carbohydrate_g: clamp(raw.carbohydrate_g, 80, 550),
    sodium_mg: clamp(raw.sodium_mg, 1000, 3200),
    rationale_zh: rationale || undefined,
  };
}

function normalizeDailyIntakeTargetsEstimateJson(parsed: unknown): DailyIntakeTargetsEstimateJson | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const pickNum = (v: unknown): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };
  const hydration_ml = pickNum(o.hydration_ml);
  const protein_g = pickNum(o.protein_g);
  const carbohydrate_g = pickNum(o.carbohydrate_g);
  const sodium_mg = pickNum(o.sodium_mg);
  if (![hydration_ml, protein_g, carbohydrate_g, sodium_mg].every(Number.isFinite)) return null;
  const rationale_zh = typeof o.rationale_zh === 'string' ? o.rationale_zh : undefined;
  return clampDailyIntakeTargetsEstimate({
    hydration_ml,
    protein_g,
    carbohydrate_g,
    sodium_mg,
    rationale_zh,
  });
}

/**
 * 根据用户档案与近七日摄入摘要，输出当日水分/蛋白质/碳水/钠目标（JSON）。
 * 与 `parseFoodIntakeFromText` 类似：串行队列、1305 重试、JSON 围栏剥离。
 */
export async function estimateDailyIntakeTargetsFromContext(
  options: EstimateDailyIntakeTargetsFromContextOptions,
): Promise<EstimateDailyIntakeTargetsFromContextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 12);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const context = options.contextBlock.trim();
  if (!context) {
    return { ok: false, error: '上下文为空', attempts: 0 };
  }

  const systemContent = `你是注册营养师风格的助手，用数据与常识为用户估算「今日摄入目标」。
只输出严格 JSON 对象，不要 markdown、不要代码围栏、不要任何 JSON 以外的文字。
字段与类型（必须全部出现）：
- hydration_ml：数字，全日饮水目标（毫升），合理范围约 1200～4000
- protein_g：数字，蛋白质目标（克）
- carbohydrate_g：数字，碳水化合物目标（克）
- sodium_mg：数字，钠目标（毫克），一般不低于 1000、不高于 3000，除非用户持续极高强度出汗且档案支持
- rationale_zh：字符串，1～2 句简体中文，概括你如何综合「用户身体档案」「近7日实际摄入」「本地公式参考值」得到上述目标；勿编造未在上下文中出现的疾病诊断或实验室数据；若信息不足，说明保守处理。

须遵守：
- 结合用户性别、年龄、身高体重、运动与目标（减脂/增肌）与近7日各营养素摄入趋势做微调；若近几日某营养素持续明显偏低或偏高，目标应温和纠正而非极端跳变。
- 若上下文标明今日为「健身日」，蛋白质与碳水可适度上调，水分与钠略增以支持训练与出汗；若标明「休息日」，在保障基础营养前提下温和低于健身日（尤其碳水与钠），勿照搬训练日定量。
- 钠目标需兼顾运动出汗与心血管风险：久坐偏低、高强度可略高；健身日可略高于同日休息日。
- 输出数值须为合理整数或最多一位小数的数字（建议四舍五入为整数）。`;

  let lastError = '未知错误';
  let lastHttp = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const dr = await dispatchZhipuTextChat({
      apiKey: key,
      systemContent,
      userContent: `请根据以下上下文生成 hydration_ml、protein_g、carbohydrate_g、sodium_mg 与 rationale_zh：\n\n${context}`,
      temperature: 0.15,
      maxTokens: 768,
      maxAttempts: 1,
      retryDelayMs: 0,
      forceJsonObject: true,
    });

    if (!dr.ok) {
      lastError = dr.error;
      lastHttp = dr.httpStatus ?? 0;
      const retryable = bodyIndicatesZhipu1305(dr.details);
      if (retryable && attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: lastHttp, details: dr.details };
    }

    const content = dr.text.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownJsonFence(content)) as unknown;
    } catch {
      lastError = '模型返回的不是合法 JSON';
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: dr.httpStatus, details: { snippet: content.slice(0, 400) } };
    }

    const data = normalizeDailyIntakeTargetsEstimateJson(parsed);
    if (!data) {
      lastError = 'JSON 字段不完整或无法解析';
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt, httpStatus: dr.httpStatus, details: { snippet: content.slice(0, 400) } };
    }

    return { ok: true, data, rawContent: content, attempts: attempt };
  }

  return { ok: false, error: lastError, attempts: maxAttempts, httpStatus: lastHttp };
}

const FINANCE_STATS_ANALYSIS_GUIDE = `analysis 写作要求（必填且须充实）：
- 简体中文，总字数控制在 300～400 字（约 5～8 句，禁止少于 280 字或超过 420 字）；
- 自然段书写，不要用 markdown、编号列表或 JSON 嵌套；
- 须依次涵盖（可写成连贯段落）：
  (1) 区间总览：收入、支出、结余的大致结构与本期特点（定性描述，勿逐条复读摘要数字）；
  (2) 分类与习惯：主要收支分类占比反映的消费/收入习惯，点出 1～2 个突出类别或变化；
  (3) 风险与亮点：大额支出、结余波动、储蓄空间或做得好的地方各 1 点（仅基于摘要，勿捏造）；
  (4) 可行建议：给出 2～3 条具体、可执行的下月或本周微调建议（如控制某类支出、设定储蓄比例、复盘高额流水）。
- 语气亲切专业；勿捏造摘要中未出现的交易、账户或金额；若几乎无收支，友好说明需多记账后再分析。`;

const FINANCE_STATS_ANALYSIS_JSON_HINT = `{"analysis":"（此处为 300～400 字结构化中文财务分析，见系统要求）"}`;

export type AnalyzeFinanceBillSummaryFromTextOptions = {
  apiKey: string;
  /** 中文统计摘要，由调用方从本地账单聚合生成 */
  summaryText: string;
  /** 遇到 1305 等可重试错误时的最大请求次数（含首次），默认 12 */
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeFinanceBillSummaryFromTextResult =
  | { ok: true; analysis: string; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function normalizeFinanceStatsAnalysisJson(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) return '';
  const o = parsed as Record<string, unknown>;
  const raw = o.analysis;
  const s = typeof raw === 'string' ? raw.trim() : raw != null ? String(raw).trim() : '';
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

/**
 * 根据账单统计摘要生成 300～400 字结构化中文分析（JSON 含 analysis 字段）。
 * 与 `parseFoodIntakeFromText` 类似：串行队列、1305 重试、JSON 围栏剥离。
 */
export async function analyzeFinanceBillSummaryFromText(
  options: AnalyzeFinanceBillSummaryFromTextOptions,
): Promise<AnalyzeFinanceBillSummaryFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 12);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.summaryText.trim();
  if (!text) {
    return { ok: false, error: '摘要为空', attempts: 0 };
  }

  const systemContent = `你是个人记账应用里的资深财务顾问。用户会提供一段时间内的本地记账统计摘要（中文，已脱敏聚合）。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含字段 analysis（字符串）：

${FINANCE_STATS_ANALYSIS_GUIDE}

输出形状示例（analysis 须替换为符合上述字数与结构的正文）：${FINANCE_STATS_ANALYSIS_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<string>({
    apiKey: key,
    systemContent,
    userContent: `以下是统计摘要，请生成充实、约 300～400 字的 analysis 字段：\n\n${text}`,
    temperature: 0.25,
    maxTokens: 1200,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const analysis = normalizeFinanceStatsAnalysisJson(parsed);
      if (!analysis) {
        return { ok: false, error: '模型未返回有效的 analysis 文案', details: parsed };
      }
      return { ok: true, value: analysis };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return { ok: true, analysis: lr.value, rawContent: lr.rawContent, attempts: lr.attempts };
}

const CASH_FLOW_DASHBOARD_ANALYSIS_GUIDE = `analysis 写作要求（必填且须充实）：
- 简体中文，总字数控制在 300～400 字（约 5～8 句，禁止少于 280 字或超过 420 字）；
- 自然段书写，不要用 markdown、编号列表或 JSON 嵌套；
- 须结合 ESBI、主动/被动收入、资产负债净现金流、自由现金流等概念，依次涵盖：
  (1) 结构总览：主动与被动收入占比、总收入与总流出的平衡感，以及当前现金流「象限」特点（定性，勿逐条复读数字）；
  (2) 资产与负债：资产性净流入、负债消耗、还款压力或净资产趋势中的 1～2 个关键点；
  (3) 流出与效率：生活支出、非必要支出、自由现金流是否健康，点出 1 个亮点或风险；
  (4) 可行建议：给出 2～3 条具体、可执行的下一步（如提升被动收入、优化负债结构、控制某类流出、补全台账等）。
- 语气亲切专业；勿捏造摘要中未出现的条目或金额；若数据几乎为空，友好引导先补全收入、支出与资产负债。`;

const CASH_FLOW_DASHBOARD_JSON_HINT = `{"analysis":"（此处为 300～400 字结构化中文现金流分析，见系统要求）"}`;

export type AnalyzeCashFlowDashboardFromTextOptions = {
  apiKey: string;
  /** 由调用方从本地现金流图状态与汇总指标组装的结构化中文摘要 */
  summaryText: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeCashFlowDashboardFromTextResult =
  | { ok: true; analysis: string; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

/**
 * 根据「现金流图」页本地数据摘要生成 300～400 字结构化分析（JSON 含 analysis 字段）。
 */
export async function analyzeCashFlowDashboardFromText(
  options: AnalyzeCashFlowDashboardFromTextOptions,
): Promise<AnalyzeCashFlowDashboardFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 12);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.summaryText.trim();
  if (!text) {
    return { ok: false, error: '摘要为空', attempts: 0 };
  }

  const systemContent = `你是个人财务应用里「现金流图」模块的资深顾问，熟悉 ESBI 四象限、主动/被动收入、资产负债净现金流与自由现金流等概念。
用户会提供从本地数据库聚合的中文摘要（已脱敏为名称与金额，无真实账号）。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含字段 analysis（字符串）：

${CASH_FLOW_DASHBOARD_ANALYSIS_GUIDE}

输出形状示例（analysis 须替换为符合上述字数与结构的正文）：${CASH_FLOW_DASHBOARD_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<string>({
    apiKey: key,
    systemContent,
    userContent: `以下是用户现金流图数据摘要，请生成充实、约 300～400 字的 analysis 字段：\n\n${text}`,
    temperature: 0.3,
    maxTokens: 1200,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const analysis = normalizeFinanceStatsAnalysisJson(parsed);
      if (!analysis) {
        return { ok: false, error: '模型未返回有效的 analysis 文案', details: parsed };
      }
      return { ok: true, value: analysis };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return { ok: true, analysis: lr.value, rawContent: lr.rawContent, attempts: lr.attempts };
}

const WISH_LIST_RATIONAL_REVIEW_JSON_HINT = `{"headline":"一句中文概括（建议不超过24字）","review":"约300～400字的理性消费深度分析正文，分段、口语化、可操作，不要markdown"}`;

export type AnalyzeWishListRationalReviewFromTextOptions = {
  apiKey: string;
  /** 心愿单与汇总的中文上下文，由调用方从本地数据组装 */
  contextText: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeWishListRationalReviewFromTextResult =
  | { ok: true; headline: string; review: string; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function normalizeWishListRationalReviewJson(parsed: unknown): { headline: string; review: string } | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  let headline = typeof o.headline === 'string' ? o.headline.trim() : '';
  let review = typeof o.review === 'string' ? o.review.trim() : '';
  if (!review && typeof o.analysis === 'string') {
    review = (o.analysis as string).trim();
  }
  if (!review && typeof o.body === 'string') {
    review = (o.body as string).trim();
  }
  if (!headline && typeof o.title === 'string') {
    headline = (o.title as string).trim();
  }
  if (headline.length > 48) headline = `${headline.slice(0, 45)}…`;
  if (review.length > 1200) review = `${review.slice(0, 1197)}…`;
  if (!review) return null;
  if (!headline) {
    const one = review.split(/[。！？\n]/)[0]?.trim() ?? review;
    headline = one.length > 24 ? `${one.slice(0, 21)}…` : one || '理性消费评审';
  }
  return { headline, review };
}

/**
 * 根据本地心愿单摘要生成「理性消费」中文标题与正文（智谱 glm-4-flash，JSON）。
 */
export async function analyzeWishListRationalReviewFromText(
  options: AnalyzeWishListRationalReviewFromTextOptions,
): Promise<AnalyzeWishListRationalReviewFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 800);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.contextText.trim();
  if (!text) {
    return { ok: false, error: '清单上下文为空', attempts: 0 };
  }

  const systemContent = `你是个人生活规划应用里的消费顾问。用户会提供本地「心愿单」的聚合摘要（中文，已脱敏；含汇总统计、类别分布、条目明细等）。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含两个字符串字段：
- headline：用一句话概括当前清单的消费风险或优先级焦点，建议不超过 24 个汉字，语气克制、不羞辱用户。
- review：正文须达到 300～400 个汉字（含标点；低于 280 字视为不合格）。用 3～5 个自然段或清晰层次展开，口语化、克制、不羞辱用户；不要 markdown；不要逐条复读清单；不要捏造摘要中未出现的商品、金额或类别。建议覆盖：
  1）整体画像：总支出、相对季度目标的占比与预算压力感；
  2）心动结构：高/中/低心动分布，是否存在「高心动+高价」集中；
  3）类别与理由：哪些条目理由充分、哪些显得冲动或信息不足；
  4）优先级：可入手、宜观望延后、可替代或降配的思路（可点名 1～2 个摘要中的典型称谓，勿罗列全部）；
  5）行动收尾：1～2 条可执行的下一步（如冷静期、分拆大额、对齐季度目标等）。
  若条目很少，可侧重需求沉淀与下单节奏，仍须写满 300 字左右。

输出形状示例（内容须替换为你的生成）：${WISH_LIST_RATIONAL_REVIEW_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<{ headline: string; review: string }>({
    apiKey: key,
    systemContent,
    userContent: `以下是心愿单上下文。请生成 headline 与 review；其中 review 正文须为 300～400 汉字：\n\n${text}`,
    temperature: 0.35,
    maxTokens: 1200,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const normalized = normalizeWishListRationalReviewJson(parsed);
      if (!normalized) {
        return { ok: false, error: '模型未返回有效的评审正文', details: parsed };
      }
      return { ok: true, value: normalized };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return {
    ok: true,
    headline: lr.value.headline,
    review: lr.value.review,
    rawContent: lr.rawContent,
    attempts: lr.attempts,
  };
}

/** 人格画像页：智谱 glm-4-flash 返回的统一 JSON 形状 */
export type PersonaPortraitAiData = {
  hero_kicker: string;
  hero_main: string;
  hero_caption: string;
  overview: string;
  bullets: string[];
  stats: { label: string; value: string; hint: string }[];
  milestones: string[];
  dims: { title: string; sub: string }[];
  /** 综合洞察（ai-insight）主段落；其它 slug 可与 overview 配合 */
  ai_quote: string;
};

const PERSONA_PORTRAIT_JSON_HINT = `{"hero_kicker":"","hero_main":"","hero_caption":"","overview":"","bullets":[],"stats":[],"milestones":[],"dims":[],"ai_quote":""}`;

export type GeneratePersonaPortraitOptions = {
  apiKey: string;
  /** plan-completion | health | savings | ai-insight */
  personaSlug: string;
  /** 中文本地数据摘要，由调用方组装 */
  contextText: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type GeneratePersonaPortraitResult =
  | { ok: true; data: PersonaPortraitAiData; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function clipPersonaStr(s: string, max: number): string {
  const t = s.trim();
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

function normalizePersonaPortraitJson(parsed: unknown): PersonaPortraitAiData {
  const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const topStr = (key: string, max: number, fallback: string) => {
    const v = o[key];
    const s = typeof v === 'string' ? v.trim() : v != null ? String(v).trim() : '';
    return s ? clipPersonaStr(s, max) : fallback;
  };

  let bullets: string[] = [];
  if (Array.isArray(o.bullets)) {
    bullets = o.bullets
      .map(x => (typeof x === 'string' ? x : String(x)).trim())
      .filter(Boolean)
      .slice(0, 6)
      .map(s => clipPersonaStr(s, 200));
  }

  const stats: { label: string; value: string; hint: string }[] = [];
  if (Array.isArray(o.stats)) {
    for (const row of o.stats.slice(0, 3)) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const label = typeof r.label === 'string' ? clipPersonaStr(r.label, 28) : clipPersonaStr(String(r.label ?? ''), 28);
      const value = typeof r.value === 'string' ? clipPersonaStr(r.value, 24) : clipPersonaStr(String(r.value ?? ''), 24);
      const hint = typeof r.hint === 'string' ? clipPersonaStr(r.hint, 48) : clipPersonaStr(String(r.hint ?? ''), 48);
      if (label || value || hint) stats.push({ label: label || '项', value: value || '—', hint });
    }
  }

  let milestones: string[] = [];
  if (Array.isArray(o.milestones)) {
    milestones = o.milestones
      .map(x => clipPersonaStr(typeof x === 'string' ? x : String(x), 140))
      .filter(Boolean)
      .slice(0, 5);
  }

  const dims: { title: string; sub: string }[] = [];
  if (Array.isArray(o.dims)) {
    for (const row of o.dims.slice(0, 5)) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const title = typeof r.title === 'string' ? clipPersonaStr(r.title, 36) : clipPersonaStr(String(r.title ?? ''), 36);
      const sub = typeof r.sub === 'string' ? clipPersonaStr(r.sub, 160) : clipPersonaStr(String(r.sub ?? ''), 160);
      if (title || sub) dims.push({ title: title || '维度', sub });
    }
  }

  return {
    hero_kicker: topStr('hero_kicker', 28, 'INSIGHT'),
    hero_main: topStr('hero_main', 40, '—'),
    hero_caption: topStr('hero_caption', 100, ''),
    overview: topStr('overview', 2000, ''),
    bullets,
    stats,
    milestones,
    dims,
    ai_quote: topStr('ai_quote', 2000, ''),
  };
}

/** overview 可选短导语上限；主解读在 bullets */
export const PERSONA_PORTRAIT_OVERVIEW_MIN_LEN = 280;
export const PERSONA_PORTRAIT_OVERVIEW_TARGET_MAX_LEN = 420;
export const PERSONA_PORTRAIT_BULLET_MIN_COUNT = 4;
export const PERSONA_PORTRAIT_BULLET_MAX_COUNT = 6;
export const PERSONA_PORTRAIT_BULLET_MIN_EACH = 28;

function personaTextLen(s: string): number {
  return s.trim().length;
}

function personaBulletsOk(d: PersonaPortraitAiData, minItems: number, maxItems: number, minEach: number): boolean {
  const items = d.bullets.map(b => b.trim()).filter(b => personaTextLen(b) >= minEach);
  return items.length >= minItems && items.length <= maxItems;
}

/** 按 slug 校验模型 JSON 是否达到「分点 AI 解读」标准；不通过则触发重试 */
export function validatePersonaPortraitForSlug(
  slug: string,
  d: PersonaPortraitAiData,
): { ok: true } | { ok: false; error: string } {
  const min = PERSONA_PORTRAIT_BULLET_MIN_COUNT;
  const max = PERSONA_PORTRAIT_BULLET_MAX_COUNT;
  const each = PERSONA_PORTRAIT_BULLET_MIN_EACH;

  if (!personaBulletsOk(d, min, max, each)) {
    const n = d.bullets.map(b => b.trim()).filter(b => personaTextLen(b) >= each).length;
    return {
      ok: false,
      error: `bullets 须 ${min}～${max} 条且每条 ≥${each} 字（当前有效 ${n} 条）`,
    };
  }

  if (personaTextLen(d.overview) > 160) {
    return { ok: false, error: 'overview 须为 0～160 字短导语，勿写长段落（主内容放在 bullets）' };
  }

  switch (slug) {
    case 'savings':
      if (d.milestones.filter(m => m.trim()).length < 2) {
        return { ok: false, error: 'milestones 须至少 2 条' };
      }
      break;
    case 'ai-insight': {
      const dims = d.dims.filter(x => x.title.trim() && x.sub.trim());
      if (dims.length < 3) {
        return { ok: false, error: 'dims 须 3 条且含 title/sub' };
      }
      for (const dim of dims) {
        if (personaTextLen(dim.sub) < 24) {
          return { ok: false, error: 'dims.sub 每条须 ≥24 字（分点式一句）' };
        }
        if (personaTextLen(dim.sub) > 100) {
          return { ok: false, error: 'dims.sub 每条勿超过 100 字' };
        }
      }
      if (personaTextLen(d.ai_quote) > 120) {
        return { ok: false, error: 'ai_quote 须 ≤120 字或留空（主解读用 bullets）' };
      }
      break;
    }
    default:
      break;
  }
  return { ok: true };
}

/**
 * 根据本地摘要生成「AI 人格画像」展示用 JSON（智谱 glm-4-flash）。
 * 与账单分析相同：串行队列、1305 重试、JSON 围栏剥离。
 */
export async function generatePersonaPortraitFromContext(
  options: GeneratePersonaPortraitOptions,
): Promise<GeneratePersonaPortraitResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 10);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 900);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const slug = options.personaSlug.trim();
  if (!slug) {
    return { ok: false, error: 'personaSlug 为空', attempts: 0 };
  }
  const text = options.contextText.trim();
  if (!text) {
    return { ok: false, error: '数据摘要为空', attempts: 0 };
  }

  const systemContent = `你是自我管理类 App 里的「人格画像」文案生成器。用户会提供 persona_slug 与一段「本地真实数据摘要」（中文，已聚合脱敏，含任务/财务/饮水等统计）。
你必须只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。

硬性规则：
1) 语气：简体中文、温暖、具体、像懂心理学的朋友；避免说教与恐吓式措辞。
2) 事实：不要编造摘要里未出现的具体金额、天数、百分比、体脂率、诊断；摘要不足时坦诚样本少，并给温和、通用的微习惯建议。
3) 医疗：身体成分、饮水、营养相关文案仅供生活方式参考，不得给出疾病诊断或用药建议。
4) 字段必须齐全（可填空字符串或空数组），类型与示例一致。
5) 解读形态（硬要求，未达标将整包判废并重试）：
   - 主解读必须用 bullets：4～6 条，每条 35～90 个汉字，独立成句、可扫读；禁止在 bullets 里用「①②③」或 markdown。四条须分别覆盖：①数据回顾（引用摘要数字）②模式洞察 ③优势与卡点 ④可执行微习惯（第 5～6 条可补充维度专属要点）。
   - overview：仅 0～80 字可选短导语（一句话定调），禁止写长段落；勿把 overview 当作主解读。
   - ai-insight：bullets 同上；ai_quote 可选 ≤80 字金句或留空；dims 固定 3 条，sub 每条 30～80 字、一句说清该维度。
   - savings：bullets 4～6 条 + milestones 2～4 条（里程碑短语，与 bullets 勿重复堆砌）。

persona_slug 含义（决定侧重点，但仍需填满所有字段；不适用的数组可给 0～3 条或留空数组）：
- plan-completion：仅任务完成、习惯打卡、青蛙优先级、闭环节奏；overview/stats/bullets 禁止出现储蓄、记账、收支、饮水、财务、心愿等非任务主题。
- health：综合健康页——身体档案（身高体重 BMI）、四营养维度日均与达成率、周环比、逐日明细；stats 建议 3 条分别对应水分/蛋白质/身体或综合照料；禁止编造体脂率或医疗诊断。
- savings：储蓄/记账/延迟满足倾向（基于摘要中的数字）。
- ai-insight：综合其它维度的一段「总评」式洞察，dims 给 3 条维度拆解。

输出形状示例（请替换内容）：${PERSONA_PORTRAIT_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<PersonaPortraitAiData>({
    apiKey: key,
    systemContent,
    userContent: `persona_slug=${slug}\n\n以下是用户本地数据摘要。请生成 JSON。
硬性要求：bullets 必须 4～6 条、每条 35～90 字的分点总结（主解读）；overview 仅 0～80 字短导语${slug === 'ai-insight' ? '；dims 三条 sub 各 30～80 字' : slug === 'savings' ? '；milestones 2～4 条' : ''}。\n\n${text}`,
    temperature: 0.38,
    maxTokens: 3600,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const data = normalizePersonaPortraitJson(parsed);
      const check = validatePersonaPortraitForSlug(slug, data);
      if (!check.ok) {
        return { ok: false, error: check.error, details: parsed };
      }
      return { ok: true, value: data };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return { ok: true, data: lr.value, rawContent: lr.rawContent, attempts: lr.attempts };
}

const FINANCE_TXN_COMMENT_JSON_HINT = `{"comment":"一句口语化中文点评，约20～40字"}`;

export type AnalyzeFinanceTxnCommentFromTextOptions = {
  apiKey: string;
  /** 单条记账的中文描述（类型、金额、名称、分类、时间等） */
  summaryText: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeFinanceTxnCommentFromTextResult =
  | { ok: true; comment: string; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function normalizeFinanceTxnCommentJson(parsed: unknown): string {
  const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const raw = o.comment;
  let s = typeof raw === 'string' ? raw.trim() : raw != null ? String(raw).trim() : '';
  s = s.replace(/^(AI|点评|评价)[：:\s]*/i, '').trim();
  if (s.length > 120) s = `${s.slice(0, 117)}…`;
  return s;
}

/**
 * 为单条收支/转账记录生成一句简短中文 AI 评价（智谱 glm-4-flash，JSON 含 comment 字段）。
 */
export async function analyzeFinanceTxnCommentFromText(
  options: AnalyzeFinanceTxnCommentFromTextOptions,
): Promise<AnalyzeFinanceTxnCommentFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 800);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.summaryText.trim();
  if (!text) {
    return { ok: false, error: '摘要为空', attempts: 0 };
  }

  const systemContent = `你是个人记账应用里的财务助手。用户会提供「单条」本地记账摘要（中文）。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含字段 comment（字符串）：
- 用 1 句口语化中文点评该笔记录（习惯、预算感、记账清晰度、转账合理性等择一相关角度即可）；
- 不要重复罗列摘要里的金额数字串；不要捏造摘要中未出现的商户或场景；
- 长度控制在 40 字以内为佳，最多不超过 80 字；
- 转账类可简短提醒注意账户对应关系即可。

输出形状示例（内容替换为你的生成）：${FINANCE_TXN_COMMENT_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<string>({
    apiKey: key,
    systemContent,
    userContent: `以下是单条记账摘要，请生成 comment 字段：\n\n${text}`,
    temperature: 0.35,
    /** 部分模型可能在 JSON 前消耗较多输出额度；200 易截断导致解析失败，略放宽 max_tokens。 */
    maxTokens: 1024,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const comment = normalizeFinanceTxnCommentJson(parsed);
      if (!comment) {
        return { ok: false, error: '模型未返回有效的 comment 文案', details: parsed };
      }
      return { ok: true, value: comment };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return { ok: true, comment: lr.value, rawContent: lr.rawContent, attempts: lr.attempts };
}

const WISH_ITEM_AI_COMMENT_JSON_HINT = `{"comment":"2～4句理性消费与必要性角度的中文点评，口语化、不羞辱用户"}`;

export type AnalyzeWishItemAiCommentFromTextOptions = {
  apiKey: string;
  /** 单条心愿的中文摘要（名称、价格、心动等级、类别、理由等） */
  summaryText: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeWishItemAiCommentFromTextResult =
  | { ok: true; comment: string; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function normalizeWishItemAiCommentJson(parsed: unknown): string {
  const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const raw = o.comment;
  let s = typeof raw === 'string' ? raw.trim() : raw != null ? String(raw).trim() : '';
  s = s.replace(/^(AI|点评|评价)[：:\s]*/i, '').trim();
  if (s.length > 520) s = `${s.slice(0, 517)}…`;
  return s;
}

/**
 * 为单条心愿单条目生成理性消费向中文评价（智谱 glm-4-flash，JSON 含 comment 字段）。
 */
export async function analyzeWishItemAiCommentFromText(
  options: AnalyzeWishItemAiCommentFromTextOptions,
): Promise<AnalyzeWishItemAiCommentFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 800);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.summaryText.trim();
  if (!text) {
    return { ok: false, error: '摘要为空', attempts: 0 };
  }

  const systemContent = `你是个人生活规划应用里的消费顾问。用户会提供「单条」本地心愿单条目摘要（中文，已脱敏）。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含字段 comment（字符串）：
- 用 2～4 句口语化中文，从必要性、预算感、心动等级与理由是否自洽、可延后或替代思路等角度点评；
- 语气克制、友善，不羞辱用户；不要编造摘要中未出现的商品细节或金额；
- 总字数建议 80～260 字，不要超过 400 字。

输出形状示例（内容替换为你的生成）：${WISH_ITEM_AI_COMMENT_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<string>({
    apiKey: key,
    systemContent,
    userContent: `以下是单条心愿摘要，请生成 comment 字段：\n\n${text}`,
    temperature: 0.35,
    maxTokens: 520,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const comment = normalizeWishItemAiCommentJson(parsed);
      if (!comment) {
        return { ok: false, error: '模型未返回有效的 comment 文案', details: parsed };
      }
      return { ok: true, value: comment };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return { ok: true, comment: lr.value, rawContent: lr.rawContent, attempts: lr.attempts };
}

const MEMO_REVIEW_JSON_HINT = `{"evaluation":"约300～400字的中文深度分析","suggestions":"多条可执行建议，总字数约250～400字，可用换行分隔"}`;

export type AnalyzeMemoReviewFromTextOptions = {
  apiKey: string;
  /** 完整备忘文本：含标题与正文，由调用方格式化 */
  memoContextText: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeMemoReviewFromTextResult =
  | { ok: true; evaluation: string; suggestions: string; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

/** 备忘等场景限制长度；缺点 AI 用 full 保留模型全文，不在此截断。 */
export type MemoReviewJsonNormalizeMode = 'memo' | 'full';

function normalizeMemoReviewJson(
  parsed: unknown,
  mode: MemoReviewJsonNormalizeMode = 'memo',
): { evaluation: string; suggestions: string } | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  let evaluation = typeof o.evaluation === 'string' ? o.evaluation.trim() : '';
  let suggestions = typeof o.suggestions === 'string' ? o.suggestions.trim() : '';
  if (!evaluation && typeof o.comment === 'string') {
    evaluation = (o.comment as string).trim();
  }
  if (!suggestions && typeof o.advice === 'string') {
    suggestions = (o.advice as string).trim();
  }
  if (mode === 'memo') {
    if (evaluation.length > 1200) evaluation = `${evaluation.slice(0, 1197)}…`;
    if (suggestions.length > 1200) suggestions = `${suggestions.slice(0, 1197)}…`;
  }
  if (!evaluation && !suggestions) return null;
  if (!evaluation) evaluation = '（模型未单独输出评价，见下方建议。）';
  if (!suggestions) suggestions = '（模型未单独输出建议，可结合上文评价自行拆解行动项。）';
  return { evaluation, suggestions };
}

async function runZhipuJsonEvaluationSuggestionsReview(options: {
  apiKey: string;
  contextText: string;
  emptyContextError: string;
  systemInstruction: string;
  userMessage: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** 默认 memo：截断过长字段；full 保留全文（缺点分析等） */
  reviewJsonNormalize?: MemoReviewJsonNormalizeMode;
  maxTokens?: number;
}): Promise<AnalyzeMemoReviewFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 800);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.contextText.trim();
  if (!text) {
    return { ok: false, error: options.emptyContextError, attempts: 0 };
  }

  const normalizeMode = options.reviewJsonNormalize ?? 'memo';
  const maxTokens = options.maxTokens ?? 900;

  const lr = await loopTextJsonLlmWithRetries<{ evaluation: string; suggestions: string }>({
    apiKey: key,
    systemContent: options.systemInstruction,
    userContent: options.userMessage,
    temperature: 0.4,
    maxTokens,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const normalized = normalizeMemoReviewJson(parsed, normalizeMode);
      if (!normalized) {
        return { ok: false, error: '模型未返回有效的评价与建议', details: parsed };
      }
      return {
        ok: true,
        value: { evaluation: normalized.evaluation, suggestions: normalized.suggestions },
      };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return {
    ok: true,
    evaluation: lr.value.evaluation,
    suggestions: lr.value.suggestions,
    rawContent: lr.rawContent,
    attempts: lr.attempts,
  };
}

/**
 * 根据单条备忘录的标题与正文生成中文「评价」与「建议」（智谱 glm-4-flash，JSON）。
 */
export async function analyzeMemoReviewFromText(
  options: AnalyzeMemoReviewFromTextOptions,
): Promise<AnalyzeMemoReviewFromTextResult> {
  const text = options.memoContextText.trim();
  return runZhipuJsonEvaluationSuggestionsReview({
    apiKey: options.apiKey,
    contextText: text,
    emptyContextError: '备忘内容为空',
    systemInstruction: `你是个人效率应用里的备忘教练。用户会提供一条本地备忘录的元信息、标题与正文（均为中文或中英混排）。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含两个字符串字段：
- evaluation：对备忘内容的深度分析，须 300～400 个汉字（含标点；低于 280 字视为不合格）。分 3～5 段展开，覆盖：意图是否清晰、结构是否便于执行、信息缺口、优先级与风险、与常见效率原则的契合度等；语气友善、具体，不人身攻击；不编造用户未写明的日程、金额或联系人。
- suggestions：基于该备忘给出多条可执行改进建议（改写、拆任务、补全要素、设提醒等），用换行或分号分隔，总字数约 250～400 字；每条建议具体可操作。

输出形状示例（内容须替换为你的生成）：${MEMO_REVIEW_JSON_HINT}`,
    userMessage: `请根据以下备忘录内容生成 evaluation 与 suggestions；evaluation 须 300～400 汉字：\n\n${text}`,
    maxAttempts: options.maxAttempts,
    retryDelayMs: options.retryDelayMs,
    maxTokens: 1400,
  });
}

const WEEKLY_REVIEW_COACHING_SYSTEM_PROMPT =
  '你是资深生活与效率教练，用简体中文回复。用户在做「每周复盘」，并可能附带近七日「每日复盘」原文。请输出结构化文本，须包含以下小节标题（逐字）：【总览】【对齐用户写下的重点】【数据侧参考】【建议与修正提醒】【下周可做的一件事】【温和结语】。语气真诚、具体、避免说教；若用户内容涉及心理危机，提醒寻求专业帮助。不要编造用户未提及的事实；每日复盘仅作线索，与周记冲突时以周记为主并温和指出差异。';

export type GenerateWeeklyReviewCoachingFromTextOptions = {
  apiKey: string;
  userPrompt: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type GenerateWeeklyReviewCoachingFromTextResult =
  | { ok: true; text: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

/**
 * 每周复盘：纯文本教练回复（智谱 glm-4-flash；与项目内其他智谱能力共用密钥与请求排队）。
 */
export async function generateWeeklyReviewCoachingFromText(
  options: GenerateWeeklyReviewCoachingFromTextOptions,
): Promise<GenerateWeeklyReviewCoachingFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 800);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const userPrompt = options.userPrompt.trim();
  if (!userPrompt) {
    return { ok: false, error: '复盘内容为空', attempts: 0 };
  }

  const pr = await loopPlainTextLlmWithRetries({
    apiKey: key,
    systemContent: WEEKLY_REVIEW_COACHING_SYSTEM_PROMPT,
    userContent: userPrompt,
    temperature: 0.65,
    maxTokens: 2048,
    maxAttempts,
    retryDelayMs,
  });

  if (!pr.ok) {
    return { ok: false, error: pr.error, attempts: pr.attempts, httpStatus: pr.httpStatus, details: pr.details };
  }
  return { ok: true, text: pr.text, attempts: pr.attempts };
}

export type AnalyzeWeaknessReviewFromTextOptions = {
  apiKey: string;
  /** 缺点名称与详情的格式化文本，由调用方生成 */
  weaknessContextText: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeProjectTasksReviewFromTextOptions = {
  apiKey: string;
  /** 项目与下属全部任务的格式化摘要，由调用方生成 */
  projectContextText: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

/**
 * 根据项目及其全部任务摘要生成中文「整体点评」与「行动建议」（智谱 glm-4-flash，JSON：evaluation / suggestions）。
 */
export async function analyzeProjectTasksReviewFromText(
  options: AnalyzeProjectTasksReviewFromTextOptions,
): Promise<AnalyzeMemoReviewFromTextResult> {
  const text = options.projectContextText.trim();
  return runZhipuJsonEvaluationSuggestionsReview({
    apiKey: options.apiKey,
    contextText: text,
    emptyContextError: '项目任务摘要为空',
    systemInstruction: `你是个人效率与项目管理应用中的项目教练。用户会提供某个本地项目的名称、状态、备注，以及该项目下全部任务（含子任务）的清单摘要，数据仅存于用户本机。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含两个字符串字段：
- evaluation：对项目整体推进情况的点评（进度健康度、优先级分布是否合理、是否存在明显风险或瓶颈、任务拆解是否清晰等），3～6 句中文，总字数约 100～280 字；语气具体、友善，不羞辱用户；不要编造摘要中未出现的任务或日期。
- suggestions：给出 3～8 条可执行建议（下一步优先做什么、如何调整优先级/截止日期、是否需要拆分或合并任务、如何降低拖延风险等），用中文分号或换行分隔，总字数建议 120～500 字。

输出形状示例（内容须替换为你的生成）：${MEMO_REVIEW_JSON_HINT}`,
    userMessage: `请根据以下项目与任务摘要生成 evaluation 与 suggestions 字段：\n\n${text}`,
    maxAttempts: options.maxAttempts,
    retryDelayMs: options.retryDelayMs,
    reviewJsonNormalize: 'full',
    maxTokens: 8192,
  });
}

/**
 * 根据用户自述的缺点名称与详情生成中文「分析回应」与「改进建议」（智谱 glm-4-flash，JSON；字段名与备忘评价一致：evaluation / suggestions）。
 */
export async function analyzeWeaknessReviewFromText(
  options: AnalyzeWeaknessReviewFromTextOptions,
): Promise<AnalyzeMemoReviewFromTextResult> {
  const text = options.weaknessContextText.trim();
  return runZhipuJsonEvaluationSuggestionsReview({
    apiKey: options.apiKey,
    contextText: text,
    emptyContextError: '缺点描述为空',
    systemInstruction: `你是个人成长应用中的「自我觉察」陪练。用户会自愿写下自己认为的一个缺点名称与详细说明（含元信息），用于自我梳理，数据仅存于用户本机。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含两个字符串字段：
- evaluation：对用户自述的善意、深度回应，须 300～400 个汉字（含标点；低于 280 字视为不合格）。分 3～5 段展开，可涉及触发情境、常见心理机制、认知重构、自我同情与优势资源等；禁止羞辱、贴负面人格标签或绝对化评判；不编造用户未写明的经历；若可能涉及临床心理健康问题，不下诊断，可温和提醒寻求专业支持。
- suggestions：给出多条可执行的改进或应对策略（微习惯、环境设计、沟通、边界、时间管理等），用换行或分号分隔，总字数约 250～400 字；须写完整、勿用「见上文」等省略。

输出形状示例（内容须替换为你的生成）：${MEMO_REVIEW_JSON_HINT}`,
    userMessage: `请根据以下用户自述的缺点信息生成 evaluation 与 suggestions；evaluation 须 300～400 汉字：\n\n${text}`,
    maxAttempts: options.maxAttempts,
    retryDelayMs: options.retryDelayMs,
    reviewJsonNormalize: 'full',
    maxTokens: 8192,
  });
}

const USER_SKILLS_PORTFOLIO_JSON_HINT = `{"per_skill":[{"skill_id":"","evaluation":"","suggestions":""}],"overall_suggestions":"约280～400字综合建议","profile_analysis":"约300～400字能力结构总评"}`;

export type UserSkillAiPortfolioSkillRow = {
  skill_id: string;
  evaluation: string;
  suggestions: string;
};

export type UserSkillAiPortfolioPayload = {
  per_skill: UserSkillAiPortfolioSkillRow[];
  overall_suggestions: string;
  profile_analysis: string;
};

export type AnalyzeUserSkillsPortfolioFromTextOptions = {
  apiKey: string;
  /** 展示用称呼 */
  userDisplayName: string;
  /** 待评估的每条技能（须含稳定 skill_id） */
  lines: { skill_id: string; dimension: string; name: string; description: string }[];
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeUserSkillsPortfolioFromTextResult =
  | { ok: true; data: UserSkillAiPortfolioPayload; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function normalizeUserSkillAiPortfolioJson(
  parsed: unknown,
  expectedSkillIds: string[],
): UserSkillAiPortfolioPayload | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const overall = typeof o.overall_suggestions === 'string' ? o.overall_suggestions.trim() : '';
  const profile = typeof o.profile_analysis === 'string' ? o.profile_analysis.trim() : '';
  const rawArr = o.per_skill;
  const arr = Array.isArray(rawArr) ? rawArr : [];
  const byId = new Map<string, UserSkillAiPortfolioSkillRow>();
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const x = item as Record<string, unknown>;
    const id = typeof x.skill_id === 'string' ? x.skill_id.trim() : '';
    if (!id) continue;
    const evaluation = typeof x.evaluation === 'string' ? x.evaluation.trim() : '';
    const suggestions = typeof x.suggestions === 'string' ? x.suggestions.trim() : '';
    byId.set(id, { skill_id: id, evaluation, suggestions });
  }
  const per_skill: UserSkillAiPortfolioSkillRow[] = expectedSkillIds.map(id => {
    const row = byId.get(id);
    if (row && (row.evaluation.length > 0 || row.suggestions.length > 0)) return row;
    return {
      skill_id: id,
      evaluation: row?.evaluation?.trim() ?? '',
      suggestions: row?.suggestions?.trim() ?? '（模型未返回该技能的有效条目，可稍后重试。）',
    };
  });
  if (!overall && !profile && per_skill.every(p => !p.evaluation && !p.suggestions)) return null;
  return {
    per_skill,
    overall_suggestions: overall.length > 0 ? overall : '（暂无综合建议，可稍后重试。）',
    profile_analysis: profile.length > 0 ? profile : '（暂无总体分析，可稍后重试。）',
  };
}

/**
 * 根据用户自报的「维度—技能—描述」生成逐技能评估与综合建议（智谱 glm-4-flash，JSON）。
 */
export async function analyzeUserSkillsPortfolioFromText(
  options: AnalyzeUserSkillsPortfolioFromTextOptions,
): Promise<AnalyzeUserSkillsPortfolioFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 900);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const lines = options.lines.filter(
    l =>
      l.skill_id.trim().length > 0 &&
      l.dimension.trim().length > 0 &&
      l.name.trim().length > 0 &&
      l.description.trim().length > 0,
  );
  if (lines.length === 0) {
    return { ok: false, error: '没有可评估的技能条目', attempts: 0 };
  }
  const expectedIds = lines.map(l => l.skill_id.trim());
  const display = options.userDisplayName.trim() || '用户';
  const bodyText = lines
    .map(l => {
      const desc = l.description.trim();
      return `【维度】${l.dimension.trim()}\n【技能】${l.name.trim()}\n【skill_id】${l.skill_id.trim()}\n【自我描述】（${desc.length} 字）\n${desc}`;
    })
    .join('\n\n---\n\n');

  const dimensionSet = new Set(lines.map(l => l.dimension.trim()));
  const userBlock = `用户称呼：${display}
待评估：${dimensionSet.size} 个维度、${lines.length} 条技能（skill_id 须原样回填）。

以下是各维度技能与自我描述：

${bodyText}`;

  const systemContent = `你是职业发展教练与技能评估顾问。用户会提供多条「维度—技能名称—自我描述」，每条有唯一 skill_id。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含字段：
- per_skill：数组；对输入中每一条技能各输出一项，且 skill_id 必须与输入完全一致。
  每项含 evaluation（字符串，约 150～220 字，客观评价当前水平、亮点与不足）、suggestions（字符串，约 120～200 字，具体可执行的提升建议）。
- overall_suggestions（字符串，约 280～400 字）：跨技能组合的发展路径、学习顺序与练习方式等综合建议，分 2～4 段。
- profile_analysis（字符串，须 300～400 个汉字，含标点；低于 280 字视为不合格）：对用户能力结构、优势短板、适合角色类型与中长期成长方向的总体深度分析，分 3～5 段。

要求：基于用户自述推断，不要捏造用户未提及的具体公司/证书/项目；语气专业、友善、具体。

输出形状示例（内容须替换为你的生成）：${USER_SKILLS_PORTFOLIO_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<UserSkillAiPortfolioPayload>({
    apiKey: key,
    systemContent,
    userContent: `${userBlock}\n\n请生成 JSON；profile_analysis 须 300～400 汉字。`,
    temperature: 0.35,
    maxTokens: 7200,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const data = normalizeUserSkillAiPortfolioJson(parsed, expectedIds);
      if (!data) {
        return { ok: false, error: '模型未返回有效的技能评估结构', details: parsed };
      }
      return { ok: true, value: data };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return { ok: true, data: lr.value, rawContent: lr.rawContent, attempts: lr.attempts };
}

export const VISION_WALL_AI_SECTION_BODY_MIN_LEN = 220;
export const VISION_WALL_AI_SECTION_BODY_TARGET_MIN_TOTAL = 1600;

const VISION_WALL_AI_JSON_HINT = `{"feasibility_score":72,"headline":"一句总评","sections":[{"title":"总体可行性评估","body":"（单节≥220字）"},{"title":"时间与节奏诊断","body":"…"},{"title":"目标组合与资源冲突","body":"…"},{"title":"优化建议与行动路径","body":"…"}],"per_goal":[{"goal_id":"","title":"","feasibility_level":"偏高|中等|偏低","remain_assessment":"…","optimization":"…"}],"closing_summary":"（收尾总结≥280字）"}`;

export type VisionWallAiSection = {
  title: string;
  body: string;
};

export type VisionWallAiPerGoalRow = {
  goal_id: string;
  title: string;
  feasibility_level: string;
  remain_assessment: string;
  optimization: string;
};

export type VisionWallAiAssessmentPayload = {
  feasibility_score: number;
  headline: string;
  sections: VisionWallAiSection[];
  per_goal: VisionWallAiPerGoalRow[];
  closing_summary: string;
};

export type AnalyzeVisionWallGoalsFromTextOptions = {
  apiKey: string;
  userDisplayName?: string;
  planDigestText: string;
  expectedGoalIds: string[];
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeVisionWallGoalsFromTextResult =
  | { ok: true; data: VisionWallAiAssessmentPayload; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function normalizeVisionWallAiAssessmentJson(
  parsed: unknown,
  expectedGoalIds: string[],
): VisionWallAiAssessmentPayload | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;

  const headline = typeof o.headline === 'string' ? o.headline.trim() : '';
  const closing =
    typeof o.closing_summary === 'string'
      ? o.closing_summary.trim()
      : typeof o.summary === 'string'
        ? o.summary.trim()
        : '';

  const scoreRaw = o.feasibility_score ?? o.score;
  const scoreNum =
    typeof scoreRaw === 'number' ? scoreRaw : typeof scoreRaw === 'string' ? Number(scoreRaw) : NaN;
  const feasibility_score = Number.isFinite(scoreNum)
    ? Math.max(0, Math.min(100, Math.round(scoreNum)))
    : 65;

  const rawSections = Array.isArray(o.sections) ? o.sections : [];
  const sections: VisionWallAiSection[] = [];
  for (const item of rawSections) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 40) : '';
    const body = typeof row.body === 'string' ? row.body.trim() : '';
    if (title && body) sections.push({ title, body });
  }

  const rawGoals = Array.isArray(o.per_goal) ? o.per_goal : Array.isArray(o.per_plan) ? o.per_plan : [];
  const byId = new Map<string, VisionWallAiPerGoalRow>();
  for (const item of rawGoals) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const goal_id = typeof row.goal_id === 'string' ? row.goal_id.trim() : '';
    if (!goal_id) continue;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const feasibility_level =
      typeof row.feasibility_level === 'string'
        ? row.feasibility_level.trim()
        : typeof row.feasibility === 'string'
          ? row.feasibility.trim()
          : '';
    const remain_assessment =
      typeof row.remain_assessment === 'string'
        ? row.remain_assessment.trim()
        : typeof row.time_assessment === 'string'
          ? row.time_assessment.trim()
          : '';
    const optimization =
      typeof row.optimization === 'string'
        ? row.optimization.trim()
        : typeof row.suggestions === 'string'
          ? row.suggestions.trim()
          : '';
    byId.set(goal_id, { goal_id, title, feasibility_level, remain_assessment, optimization });
  }

  const per_goal: VisionWallAiPerGoalRow[] = expectedGoalIds.map(id => {
    const row = byId.get(id);
    if (row && (row.remain_assessment || row.optimization)) return row;
    return {
      goal_id: id,
      title: row?.title ?? '',
      feasibility_level: row?.feasibility_level ?? '中等',
      remain_assessment: row?.remain_assessment ?? '（模型未返回该条目的时间评估）',
      optimization: row?.optimization ?? '（模型未返回该条目的优化建议）',
    };
  });

  if (sections.length < 3 && !headline && !closing) return null;

  const sectionsTotalLen = sections.reduce((s, x) => s + x.body.length, 0);
  if (sections.length < 3 || sectionsTotalLen < VISION_WALL_AI_SECTION_BODY_TARGET_MIN_TOTAL) {
    return null;
  }
  for (const sec of sections) {
    if (sec.body.length < VISION_WALL_AI_SECTION_BODY_MIN_LEN) return null;
  }
  if (closing.length < 260) return null;

  return {
    feasibility_score,
    headline: headline.length > 0 ? headline : '年度目标组合需结合时间与进度综合调整',
    sections,
    per_goal,
    closing_summary: closing,
  };
}

/**
 * 总目标墙：根据各计划进度、截止日与剩余完成时间，生成可行性评估与优化建议（智谱 JSON，格式化 sections）。
 */
export async function analyzeVisionWallGoalsFromText(
  options: AnalyzeVisionWallGoalsFromTextOptions,
): Promise<AnalyzeVisionWallGoalsFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 900);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const digest = options.planDigestText.trim();
  if (!digest) {
    return { ok: false, error: '没有可评估的计划数据', attempts: 0 };
  }
  const expectedGoalIds = options.expectedGoalIds.filter(id => id.trim().length > 0);
  if (expectedGoalIds.length === 0) {
    return { ok: false, error: '没有可评估的计划条目', attempts: 0 };
  }

  const display = options.userDisplayName?.trim() || '用户';
  const userBlock = `用户称呼：${display}
待评估计划条目数：${expectedGoalIds.length}（goal_id 须原样回填至 per_goal）

${digest}`;

  const systemContent = `你是年度目标规划教练与可行性分析顾问。用户会提供其「总目标墙」上的全部计划（含总目标、小目标、存钱计划），每条已标注截止日与「剩余完成时间」。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要 JSON 以外的文字。
必须包含：
- feasibility_score：0～100 整数，表示当前目标组合整体可达成度主观评分；
- headline：16～32 字中文，概括整体判断；
- sections：数组，至少 4 项，每项含 title（8～20 字小节标题）与 body（简体中文单节正文须 ≥${VISION_WALL_AI_SECTION_BODY_MIN_LEN} 字；全文字数尽量充实，四节合计建议 ≥${VISION_WALL_AI_SECTION_BODY_TARGET_MIN_TOTAL} 字）。建议小节：总体可行性评估、时间与节奏诊断、目标组合与资源冲突、优化建议与行动路径。自然段书写，不要用 markdown 符号。
- per_goal：数组；对输入中每一条计划各输出一项，goal_id 必须与输入完全一致。每项含 title（可复述计划名）、feasibility_level（偏高/中等/偏低 三选一）、remain_assessment（结合剩余完成时间与进度，约 80～150 字）、optimization（可执行优化建议，约 100～180 字）。
- closing_summary：收尾总结，须 ≥280 字，分 2～4 段，归纳优先级排序与下月行动清单。

要求：基于摘要推断，勿捏造未出现的金额/日期；数据稀少时说明需先补全目标与进度；语气专业、具体、鼓励。

输出形状示例（内容须替换）：${VISION_WALL_AI_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<VisionWallAiAssessmentPayload>({
    apiKey: key,
    systemContent,
    userContent: `${userBlock}\n\n请生成 JSON；sections 各节 body 须充实，closing_summary 须 ≥280 字。`,
    temperature: 0.38,
    maxTokens: 8192,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const data = normalizeVisionWallAiAssessmentJson(parsed, expectedGoalIds);
      if (!data) {
        return { ok: false, error: '模型未返回有效的目标墙评估结构或篇幅不足', details: parsed };
      }
      return { ok: true, value: data };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return { ok: true, data: lr.value, rawContent: lr.rawContent, attempts: lr.attempts };
}

const FINANCE_ONE_LINER_JSON_HINT = `{"transaction_type":"expense","amount":28,"name":"午饭","category_label":"餐饮"}`;

export type ParseFinanceOneLinerFromTextOptions = {
  apiKey: string;
  /** 用户一句话记账描述，中文 */
  text: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** 用户已有账户，供 AI 从话术中识别付款/收款账户 */
  accounts?: ParseFinanceOneLinerFromImageAccountHint[];
};

export type ParseFinanceOneLinerFromTextResult =
  | {
      ok: true;
      transaction_type: 'expense' | 'income';
      amount: number;
      name: string;
      category_label: string | null;
      payment_account_label: string | null;
      account_name: string | null;
      rawContent: string;
      attempts: number;
    }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

function normalizeFinanceOneLinerPayload(parsed: unknown): {
  transaction_type: 'expense' | 'income';
  amount: number;
  name: string;
  category_label: string | null;
} | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const typeRaw = String(o.transaction_type ?? 'expense').toLowerCase();
  const transaction_type: 'expense' | 'income' = typeRaw === 'income' ? 'income' : 'expense';
  const rawAmt = o.amount;
  const amount =
    typeof rawAmt === 'number' && Number.isFinite(rawAmt)
      ? rawAmt
      : Number(String(rawAmt ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const nameRaw = typeof o.name === 'string' ? o.name.trim() : String(o.name ?? '').trim();
  if (!nameRaw) return null;
  const cat = o.category_label;
  const category_label =
    typeof cat === 'string' && cat.trim().length > 0 ? cat.trim().slice(0, 40) : null;
  return {
    transaction_type,
    amount: Math.min(Math.max(amount, 0.01), 99999999.99),
    name: nameRaw.length > 80 ? `${nameRaw.slice(0, 77)}…` : nameRaw,
    category_label,
  };
}

function readIsBillFromPayload(parsed: unknown): boolean | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const v = o.is_bill ?? o.isBill ?? o.is_valid_bill;
  if (typeof v === 'boolean') return v;
  if (v === 'false' || v === 0 || v === '0') return false;
  if (v === 'true' || v === 1 || v === '1') return true;
  return null;
}

function normalizeFinanceOneLinerFromImagePayload(parsed: unknown): {
  is_bill: boolean;
  transaction_type: 'expense' | 'income';
  amount: number;
  name: string;
  category_label: string | null;
  payment_account_label: string | null;
  account_name: string | null;
} | null {
  const base = normalizeFinanceOneLinerPayload(parsed);
  if (!base) return null;
  const isBill = readIsBillFromPayload(parsed) ?? true;
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...base, is_bill: isBill, payment_account_label: null, account_name: null };
  }
  const o = parsed as Record<string, unknown>;
  const payRaw = o.payment_account_label ?? o.payment_account ?? o.pay_account;
  const payment_account_label =
    typeof payRaw === 'string' && payRaw.trim().length > 0 ? payRaw.trim().slice(0, 80) : null;
  const accRaw = o.account_name ?? o.matched_account_name;
  const account_name = typeof accRaw === 'string' && accRaw.trim().length > 0 ? accRaw.trim().slice(0, 80) : null;
  return { ...base, is_bill: isBill, payment_account_label, account_name };
}

/**
 * 将用户「一句话」记账解析为类型、金额、标题与可选分类提示（智谱 glm-4-flash，JSON）。
 */
export async function parseFinanceOneLinerFromText(
  options: ParseFinanceOneLinerFromTextOptions,
): Promise<ParseFinanceOneLinerFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 800);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.text.trim();
  if (!text) {
    return { ok: false, error: '输入为空', attempts: 0 };
  }

  const hasAccounts = Array.isArray(options.accounts) && options.accounts.length > 0;
  const accountLines = hasAccounts
    ? options.accounts!
        .map((a) => {
          const no = a.account_no?.trim();
          return no ? `- ${a.name}（尾号 ${no.replace(/\D/g, '').slice(-4) || no}）` : `- ${a.name}`;
        })
        .join('\n')
    : '';
  const jsonHint = hasAccounts
    ? `{"transaction_type":"expense","amount":28,"name":"午饭","category_label":"餐饮","payment_account_label":"支付宝","account_name":"支付宝"}`
    : FINANCE_ONE_LINER_JSON_HINT;

  const systemContent = `你是个人记账应用里的解析器。用户会输入一句中文口语化记账描述（可含金额、收支方向、事由）。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。
必须包含字段：
1) transaction_type：字符串，仅允许 "expense" 或 "income"。默认支出；若明确为工资/奖金/到账/退款/回款/进账等则为收入。
2) amount：正数（元），从用户话中提取主金额；不要编造用户未写的数字。
3) name：简短中文标题（≤20字），概括事由，不要含「JSON」等词。
4) category_label：可为 null 或简短中文分类名（如 餐饮、交通、购物、工资），尽力从语义推断；不确定则 null。
5) payment_account_label：话术中提到的付款/收款方式原文（如「支付宝」「微信」「招行卡」）；未提及则 null。
${
  hasAccounts
    ? `6) account_name：若话术中能对应到下列账户之一则填其名称，否则 null。不得编造列表外名称：\n${accountLines}`
    : ''
}

若用户话里没有任何可解析的金额，不要猜测金额，此时仍输出 JSON 但 amount 填 0（调用方将判为失败）。

输出形状示例（内容替换）：${jsonHint}`;

  type FinanceOneLinerNorm = NonNullable<ReturnType<typeof normalizeFinanceOneLinerFromImagePayload>>;
  const lr = await loopTextJsonLlmWithRetries<FinanceOneLinerNorm>({
    apiKey: key,
    systemContent,
    userContent: `请解析以下一句话记账：\n\n${text.slice(0, 500)}`,
    temperature: 0.1,
    maxTokens: 400,
    maxAttempts,
    retryDelayMs,
    finish: parsed => {
      const norm = normalizeFinanceOneLinerFromImagePayload(parsed);
      if (!norm || !Number.isFinite(norm.amount) || norm.amount <= 0) {
        return { ok: false, error: '未能从话中解析出有效金额与标题', details: parsed };
      }
      return { ok: true, value: norm };
    },
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }

  let account_name = lr.value.account_name;
  if (hasAccounts && account_name) {
    const allowed = new Set(options.accounts!.map((a) => a.name.trim()));
    if (!allowed.has(account_name.trim())) {
      account_name = null;
    }
  }

  return {
    ok: true,
    transaction_type: lr.value.transaction_type,
    amount: lr.value.amount,
    name: lr.value.name,
    category_label: lr.value.category_label,
    payment_account_label: lr.value.payment_account_label,
    account_name,
    rawContent: lr.rawContent,
    attempts: lr.attempts,
  };
}

function stripDataUriForVision(input: string): { base64: string; mime: string } {
  const s = input.trim();
  const m = s.match(/^data:([^;]+);base64,(.+)$/is);
  if (m) {
    const mime = (m[1] || 'image/png').trim() || 'image/png';
    return { mime, base64: m[2].replace(/\s/g, '') };
  }
  return { mime: 'image/png', base64: s.replace(/\s/g, '') };
}

export type ParseFinanceOneLinerFromImageAccountHint = {
  name: string;
  account_no?: string | null;
};

export type ParseFinanceOneLinerFromImageOptions = {
  apiKey: string;
  /** 剪贴板 `getImageAsync` 返回的 `data`（含 `data:image/...;base64,` 前缀） */
  imageDataUri: string;
  /** 用户已有账户，供 AI 在截图付款方式与用户账户间做对应 */
  accounts?: ParseFinanceOneLinerFromImageAccountHint[];
  /** 识别失败时的重试次数（含首次），默认 1 */
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type ParseFinanceOneLinerFromImageResult =
  | {
      ok: true;
      transaction_type: 'expense' | 'income';
      amount: number;
      name: string;
      category_label: string | null;
      /** 截图上显示的付款/扣款方式原文（如「花呗」「招商银行信用卡(1234)」） */
      payment_account_label: string | null;
      /** 从 `accounts` 中选出的账户名称；无法判断时为 null */
      account_name: string | null;
      rawContent: string;
      attempts: number;
    }
  | { ok: false; error: string; attempts: number; notBill?: boolean; httpStatus?: number; details?: unknown };

/**
 * 从支付/账单/小票等截图中解析一笔主交易（视觉模型 + JSON，与一句话记账字段一致）。
 */
export async function parseFinanceOneLinerFromImage(
  options: ParseFinanceOneLinerFromImageOptions,
): Promise<ParseFinanceOneLinerFromImageResult> {
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const uri = options.imageDataUri.trim();
  if (!uri) {
    return { ok: false, error: '图片为空', attempts: 0 };
  }

  const { base64, mime } = stripDataUriForVision(uri);
  if (!base64) {
    return { ok: false, error: '无法解析图片数据', attempts: 0 };
  }

  const hasAccounts = Array.isArray(options.accounts) && options.accounts.length > 0;
  const accountLines = hasAccounts
    ? options.accounts!
        .map((a) => {
          const no = a.account_no?.trim();
          return no ? `- ${a.name}（尾号 ${no.replace(/\D/g, '').slice(-4) || no}）` : `- ${a.name}`;
        })
        .join('\n')
    : '';

  const jsonTemplate = hasAccounts
    ? `{"is_bill":true,"transaction_type":"expense","amount":0,"name":"","category_label":null,"payment_account_label":null,"account_name":null}`
    : `{"is_bill":true,"transaction_type":"expense","amount":0,"name":"","category_label":null,"payment_account_label":null}`;

  const question =
    '请查看这张手机屏幕截图（可能是支付成功页、账单详情、小票、转账或收款记录等）。识别其中一笔主要交易；若有多笔，取金额最大或信息最完整的一笔。\n' +
    'is_bill：若截图不是支付/账单/小票/转账或收款等消费凭证（例如聊天、相册、游戏、风景、设置页等），设为 false，其余字段可填默认值，amount 填 0。\n' +
    '要求：transaction_type 仅 expense 或 income；amount 为人民币元且为正数，不得编造截图中不存在的数字；name 为不超过 20 字的中文事由；category_label 为简短中文分类名或 null。\n' +
    'payment_account_label：截图中实际扣款/付款方式的中文原文（如「花呗」「零钱」「招商银行信用卡(1234)」）；看不清则 null。\n' +
    (hasAccounts
      ? `account_name：必须从下列用户账户名称中选一，选与截图付款方式最匹配的一项；无法对应则 null。不得编造列表外的名称：\n${accountLines}\n`
      : '') +
    '若无法识别任何可信金额，将 amount 设为 0。';

  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 800);
  let lastError = '未能从截图中识别出有效金额与标题';
  let lastHttpStatus: number | undefined;
  let lastDetails: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const r = await parseImageToJson({
      apiKey: key,
      imageBase64: base64,
      imageMimeType: mime,
      question,
      jsonTemplate,
    });

    if (!r.ok) {
      lastError = r.error;
      lastHttpStatus = r.httpStatus;
      lastDetails = r.details;
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      return {
        ok: false,
        error: lastError,
        attempts: attempt,
        httpStatus: lastHttpStatus,
        details: lastDetails,
      };
    }

    let payload = normalizeFinanceOneLinerFromImagePayload(r.data);
    if (!payload && r.data && typeof r.data === 'object') {
      const inner = (r.data as Record<string, unknown>).result;
      payload = normalizeFinanceOneLinerFromImagePayload(inner);
    }
    if (payload && payload.is_bill === false) {
      return {
        ok: false,
        error: '这不是账单或支付凭证截图',
        notBill: true,
        attempts: attempt,
        details: r.data,
      };
    }
    if (!payload || !Number.isFinite(payload.amount) || payload.amount <= 0) {
      lastError = '未能从截图中识别出有效金额与标题';
      lastHttpStatus = undefined;
      lastDetails = r.data;
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      return {
        ok: false,
        error: lastError,
        attempts: attempt,
        details: lastDetails,
      };
    }

    let account_name = payload.account_name;
    if (hasAccounts && account_name) {
      const allowed = new Set(options.accounts!.map((a) => a.name.trim()));
      if (!allowed.has(account_name.trim())) {
        account_name = null;
      }
    }

    return {
      ok: true,
      transaction_type: payload.transaction_type,
      amount: payload.amount,
      name: payload.name,
      category_label: payload.category_label,
      payment_account_label: payload.payment_account_label,
      account_name,
      rawContent: r.rawContent,
      attempts: attempt,
    };
  }

  return {
    ok: false,
    error: lastError,
    attempts: maxAttempts,
    httpStatus: lastHttpStatus,
    details: lastDetails,
  };
}

/** 深度洞察卡片；body 建议 300～400 字 */
export type AiFinanceDashboardInsight = { title: string; body: string };

/** AI 财务分析页：健康分、洞察、支出点评 + 三组 12 个月预测（前 6 历史 + 后 6 预测，单位：元） */
export type AiFinanceDashboardPayload = {
  health_score: number;
  health_summary: string;
  insights: [AiFinanceDashboardInsight, AiFinanceDashboardInsight];
  expense_breakdown_comment: string;
  /** 月度净储蓄：索引 0～5 过去 6 个月（旧→新），5 为本月；6～11 为预测未来 6 个月 */
  savings_forecast_12: number[];
  /** 月度收入合计，同上 12 个月结构 */
  income_forecast_12: number[];
  /** 月度盈余（与净储蓄同口径即可），同上 */
  surplus_forecast_12: number[];
};

export type AnalyzeAiFinanceDashboardFromTextOptions = {
  apiKey: string;
  summaryText: string;
  /** 过去 6 个月每月净储蓄（元，旧→新），用于约束/补全曲线 */
  past6NetSavings?: number[];
  /** 过去 6 个月每月收入合计（元，旧→新） */
  past6Income?: number[];
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeAiFinanceDashboardFromTextResult =
  | { ok: true; data: AiFinanceDashboardPayload; rawContent: string; attempts: number }
  | { ok: false; error: string; attempts: number; httpStatus?: number; details?: unknown };

const AI_FINANCE_DASHBOARD_INSIGHTS_GUIDE = `insights 写作要求（长度恰好为 2 的数组，每项含 title 与 body，这是「AI 深度洞察」核心内容，须充实）：
- title：8～16 字中文短语，概括本条洞察主题（如「储蓄率承压」「固定支出占比偏高」）；
- body：简体中文 300～400 字（约 5～8 句，禁止少于 280 字或超过 420 字）；自然段书写，不要 markdown、编号列表或 JSON 嵌套；
- 两条洞察须角度不同：例如一条偏「收支、储蓄率与月度节奏」，另一条偏「支出结构、风险点与下月可执行行动」；
- 每条 body 须涵盖：(1) 基于摘要的现状判断（定性为主，勿逐条复读所有数字）；(2) 1～2 个具体风险或亮点；(3) 2～3 条可执行建议；
- 禁止编造摘要中未出现的金额、账户或交易；数据极少时说明需先补全记账。`;

const AI_FINANCE_DASHBOARD_JSON_HINT = `{"health_score":72,"health_summary":"…","insights":[{"title":"…","body":"（单条 300～400 字）"},{"title":"…","body":"（单条 300～400 字）"}],"expense_breakdown_comment":"…","savings_forecast_12":[0,0,0,0,0,0,0,0,0,0,0,0],"income_forecast_12":[0,0,0,0,0,0,0,0,0,0,0,0],"surplus_forecast_12":[0,0,0,0,0,0,0,0,0,0,0,0]}`;

function clampHealthScore0to100(n: unknown): number {
  const x = typeof n === 'number' ? n : typeof n === 'string' ? Number(String(n).trim().replace(/,/g, '')) : NaN;
  if (!Number.isFinite(x)) return 65;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function linearExtrapolate12From6(past6: number[], clampNonNegative: boolean): number[] {
  const n = 6;
  const series = past6.length >= n ? past6.slice(-n) : [...past6, ...Array(n - past6.length).fill(0)];
  const xAvg = 2.5;
  const yAvg = series.reduce((s, v) => s + v, 0) / n;
  const denom = series.reduce((s, _, i) => s + (i - xAvg) ** 2, 0);
  const num = series.reduce((s, v, i) => s + (i - xAvg) * (v - yAvg), 0);
  const slope = denom === 0 ? 0 : num / denom;
  const intercept = yAvg - slope * xAvg;
  const future = Array.from({ length: 6 }, (_, i) => {
    const y = intercept + slope * (n + i);
    if (clampNonNegative) return Math.max(0, y);
    return y;
  });
  return [...series, ...future];
}

function coerceNumber12(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (out.length >= 12) break;
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/,/g, ''));
    out.push(Number.isFinite(n) ? n : 0);
  }
  return out.length === 12 ? out : null;
}

function mergeAiForecast12(raw: unknown, fallbackPast6: number[], clampNonNegative: boolean): number[] {
  const c = coerceNumber12(raw);
  if (c) return c;
  return linearExtrapolate12From6(fallbackPast6, clampNonNegative);
}

function normalizeAiFinanceDashboardPayload(
  parsed: unknown,
  ctx: { past6Net: number[]; past6Income: number[] },
): AiFinanceDashboardPayload {
  const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};

  const health_score = clampHealthScore0to100(o.health_score ?? o.score ?? o.health);

  const health_summaryRaw =
    typeof o.health_summary === 'string'
      ? o.health_summary.trim()
      : typeof o.health_desc === 'string'
        ? o.health_desc.trim()
        : '';
  const health_summary =
    health_summaryRaw.length > 0 ? health_summaryRaw.slice(0, 420) : '本月收支结构整体可控，建议继续保持记账并关注固定支出占比。';

  const expenseRaw =
    typeof o.expense_breakdown_comment === 'string'
      ? o.expense_breakdown_comment.trim()
      : typeof o.expense_comment === 'string'
        ? o.expense_comment.trim()
        : typeof o.category_comment === 'string'
          ? o.category_comment.trim()
          : '';
  const expense_breakdown_comment =
    expenseRaw.length > 0 ? expenseRaw.slice(0, 900) : '建议为高频支出设置分类预算，并定期回顾「非必要」支出项。';

  const rawList = Array.isArray(o.insights) ? o.insights : Array.isArray(o.insight_cards) ? o.insight_cards : [];
  const parsedInsights: AiFinanceDashboardInsight[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const title =
      typeof row.title === 'string'
        ? row.title.trim().slice(0, 28)
        : typeof row.kicker === 'string'
          ? row.kicker.trim().slice(0, 28)
          : '';
    const body =
      typeof row.body === 'string'
        ? row.body.trim()
        : typeof row.text === 'string'
          ? row.text.trim()
          : '';
    if (title && body) parsedInsights.push({ title, body: body.slice(0, 450) });
    if (parsedInsights.length >= 2) break;
  }

  while (parsedInsights.length < 2) {
    parsedInsights.push({
      title: parsedInsights.length === 0 ? '收支节奏' : '延伸建议',
      body:
        parsedInsights.length === 0
          ? '在数据较少时，优先保证「收入、固定支出、储蓄」三类记录完整，再逐步细化分类。'
          : '可把部分结余转入低风险流动性资产作为安全垫，避免月光。',
    });
  }

  const insights: [AiFinanceDashboardInsight, AiFinanceDashboardInsight] = [
    parsedInsights[0]!,
    parsedInsights[1]!,
  ];

  const past6Net = ctx.past6Net.length === 6 ? ctx.past6Net : [0, 0, 0, 0, 0, 0];
  const past6Income = ctx.past6Income.length === 6 ? ctx.past6Income : [0, 0, 0, 0, 0, 0];

  const savings_forecast_12 = mergeAiForecast12(
    o.savings_forecast_12 ?? o.savings_forecast ?? o.forecast_savings_12,
    past6Net,
    false,
  );
  const income_forecast_12 = mergeAiForecast12(
    o.income_forecast_12 ?? o.income_forecast ?? o.forecast_income_12,
    past6Income,
    true,
  );
  const surplus_forecast_12 = mergeAiForecast12(
    o.surplus_forecast_12 ?? o.surplus_forecast ?? o.net_forecast_12 ?? o.savings_forecast_12,
    past6Net,
    false,
  );

  return { health_score, health_summary, insights, expense_breakdown_comment, savings_forecast_12, income_forecast_12, surplus_forecast_12 };
}

/**
 * AI 财务分析页专用：根据「本月汇总 + 分类 + 趋势数字」摘要，返回健康分、两条深度洞察（各约 300～400 字）、支出结构点评。
 */
export async function analyzeAiFinanceDashboardFromText(
  options: AnalyzeAiFinanceDashboardFromTextOptions,
): Promise<AnalyzeAiFinanceDashboardFromTextResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 12);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0 };
  }
  const text = options.summaryText.trim();
  if (!text) {
    return { ok: false, error: '摘要为空', attempts: 0 };
  }

  const past6Net =
    Array.isArray(options.past6NetSavings) && options.past6NetSavings.length === 6
      ? options.past6NetSavings.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0))
      : [0, 0, 0, 0, 0, 0];
  const past6Income =
    Array.isArray(options.past6Income) && options.past6Income.length === 6
      ? options.past6Income.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0))
      : [0, 0, 0, 0, 0, 0];

  const systemContent = `你是个人记账应用里的资深财务顾问。用户会提供「本月及近月」聚合后的中文统计摘要（来自本地数据库，已脱敏）。
摘要可能包含两段：**记账流水**（实际收支与分类）与 **现金流图·月度模型**（ESBI 象限收入、资产负债台账、必要/非必要流出、自由现金流等，与记账口径独立）。若存在现金流图段落，生成 health_score、insights 与三组 12 个月预测曲线时须综合两段信息：记账历史约束索引 0～5 的实际数值；现金流图中的被动收入占比、负债月供、自由现金流与财务形态用于校准未来 6 个月（索引 6～11）的趋势方向与合理性，勿与记账数字简单相加重复计数。
只输出一个标准 JSON 对象，不要 markdown 代码块、不要任何 JSON 以外的文字。

必须包含字段：
1) health_score：0～100 的整数，综合储蓄率、收支稳定性、支出集中度等给出主观评分；无收入或数据极少时给 40～60 并偏低。
2) health_summary：2～3 句中文（约 60～120 字），概括财务健康度（不要出现「JSON」「字段」等词）。
3) insights（AI 深度洞察，最重要）：
${AI_FINANCE_DASHBOARD_INSIGHTS_GUIDE}
4) expense_breakdown_comment：3～5 句中文（约 120～200 字），结合摘要里的支出分类占比做点评；若几乎无支出则提醒多记录。
5) savings_forecast_12：长度恰好 12 的**数字数组**（单位：元）。索引 0～5 必须与摘要中「过去 6 个月每月净储蓄（收入−支出）」记账数值一致或极其接近；索引 5 为本月；索引 6～11 为未来 6 个月净储蓄预测，须结合现金流图中的自由现金流、负债消耗与被动收入趋势做平滑外推，避免断崖式跳变（除非摘要支持）。
6) income_forecast_12：长度恰好 12 的数字数组（元）。索引 0～5 与摘要中过去 6 个月每月收入合计（记账）一致或接近；6～11 为未来 6 个月收入预测（非负），可参考现金流图中主动/被动收入结构与目标被动收入。
7) surplus_forecast_12：长度恰好 12 的数字数组（元），表示每月「盈余/可储蓄」口径；通常可与净储蓄同趋势，但允许结合现金流图自由现金流微调；索引 0～5 与过去 6 个月实际盈余对齐，6～11 为预测。

输出形状示例（insights 的 body 须替换为符合上述字数要求的正文）：${AI_FINANCE_DASHBOARD_JSON_HINT}`;

  const lr = await loopTextJsonLlmWithRetries<AiFinanceDashboardPayload>({
    apiKey: key,
    systemContent,
    userContent: `请根据以下摘要生成上述 JSON；其中 insights 两条 body 各须约 300～400 字：\n\n${text.slice(0, 12000)}`,
    temperature: 0.2,
    maxTokens: 4500,
    maxAttempts,
    retryDelayMs,
    finish: parsed => ({
      ok: true,
      value: normalizeAiFinanceDashboardPayload(parsed, { past6Net, past6Income }),
    }),
  });

  if (!lr.ok) {
    return { ok: false, error: lr.error, attempts: lr.attempts, httpStatus: lr.httpStatus, details: lr.details };
  }
  return { ok: true, data: lr.value, rawContent: lr.rawContent, attempts: lr.attempts };
}

export type ZhipuVisionChatRawOptions = {
  apiKey: string;
  imageBase64: string;
  imageMimeType?: string;
  /** 用户对图片的提问或闲聊引导 */
  userPrompt?: string;
  /** 遇到 1305 时最多请求次数（含首次），默认 40 */
  maxAttempts?: number;
  /** 两次请求间隔（毫秒），默认 1000 */
  retryDelayMs?: number;
};

/** 智谱业务错误码 1305（如限流/繁忙）时需重试 */
function bodyIndicatesZhipu1305(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const o = body as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === 'object') {
    const code = (err as Record<string, unknown>).code;
    if (code !== undefined && String(code) === '1305') return true;
  }
  if (o.code !== undefined && String(o.code) === '1305') return true;
  if (o.error_code !== undefined && String(o.error_code) === '1305') return true;
  return false;
}

/** 存在非空的 choices[0].message.content 视为有效完成 */
function bodyHasValidCompletion(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message;
  if (!message || typeof message !== 'object') return false;
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' && content.trim().length > 0;
}

/** 视觉对话：不约定 response_format；若返回 1305 则自动重试直至得到有效回复或达到次数上限 */
export async function zhipuVisionChatRaw(options: ZhipuVisionChatRawOptions): Promise<{
  httpStatus: number;
  body: unknown;
  attempts: number;
}> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 40);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);

  const key = options.apiKey.trim();
  if (!key) {
    return { httpStatus: 0, body: { error: '未配置 API 密钥' }, attempts: 0 };
  }

  const mime = (options.imageMimeType ?? 'image/jpeg').trim() || 'image/jpeg';
  const userText = (options.userPrompt ?? '随便聊聊这张图里有什么、你的感受也行。').trim() || '随便聊聊这张图。';

  let lastHttpStatus = 0;
  let lastBody: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const dr = await dispatchZhipuVisionChat({
      apiKey: key,
      systemContent:
        '用户会发图片。请用自然、口语化的中文像朋友一样分享你看到的内容和联想，不必遵守固定输出格式，不要用 JSON。',
      userText,
      imageBase64: options.imageBase64,
      imageMimeType: mime,
      temperature: 0.7,
      maxTokens: 2048,
      maxAttempts: 1,
      retryDelayMs: 0,
      forceJsonObject: false,
      zhipuVisionModel: 'glm-4.6v-flash',
    });

    if (dr.ok) {
      const trimmed = dr.text.trim();
      if (trimmed) {
        const synBody = { choices: [{ message: { content: trimmed } }] };
        return { httpStatus: dr.httpStatus, body: synBody, attempts: attempt };
      }
      lastBody = { error: 'empty_response' };
    } else {
      lastBody = dr.details ?? { error: dr.error };
    }

    lastHttpStatus = dr.httpStatus ?? lastHttpStatus;
    const outboundDetails = dr.ok ? undefined : dr.details;
    const retryable =
      (dr.ok && !dr.text.trim() && attempt < maxAttempts) ||
      (!dr.ok && bodyIndicatesZhipu1305(outboundDetails));
    if (retryable && attempt < maxAttempts) {
      await sleep(retryDelayMs);
      continue;
    }

    return { httpStatus: dr.httpStatus ?? lastHttpStatus, body: lastBody, attempts: attempt };
  }

  return { httpStatus: lastHttpStatus, body: lastBody, attempts: maxAttempts };
}

/** 极小 JPEG（约几十字节），用于仅测连通性、无需相册 */
export const TINY_TEST_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=';

/** 食物营养分析：全部为数字；非食物时用 is_food=0 与 non_food_code 表示原因 */
export type FoodNutritionJson = {
  /** 1=图中为可估算的食物；0=非食物或无法按食物分析 */
  is_food: 0 | 1;
  /**
   * is_food=1 时必须为 0。
   * is_food=0 时：1=明显非食物；2=无法识别/不清晰；3=多物混杂无法单一估算
   */
  non_food_code: number;
  /** is_food=1 时：识别到的食物/菜品简称（简短中文） */
  food_name: string;
  /** is_food=1 时：120～400 字结构化点评；is_food=0 时为空字符串 */
  ai_evaluation: string;
  /** 可食部分估算蛋白质，克 */
  protein_g: number;
  /** 可食部分估算碳水化合物，克 */
  carbohydrate_g: number;
  /** 可食部分估算钠，毫克 */
  sodium_mg: number;
};

export type AnalyzeFoodNutritionOptions = {
  apiKey: string;
  imageBase64: string;
  imageMimeType?: string;
  /** 用户选填的补充说明（如份量、菜名提示），与图片一并交给模型参考 */
  supplementText?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type AnalyzeFoodNutritionResult =
  | { ok: true; data: FoodNutritionJson; attempts: number; rawContent: string; repaired: boolean }
  | {
      ok: false;
      error: string;
      attempts: number;
      httpStatus?: number;
      /** 请求失败时的兜底结构，便于界面展示 */
      data: FoodNutritionJson;
    };

const FOOD_NUTRITION_FALLBACK: FoodNutritionJson = {
  is_food: 0,
  non_food_code: 2,
  food_name: '',
  ai_evaluation: '',
  protein_g: 0,
  carbohydrate_g: 0,
  sodium_mg: 0,
};

function extractMessageContentFromZhipuBody(body: unknown): string | null {
  if (!bodyHasValidCompletion(body)) return null;
  const choices = (body as Record<string, unknown>).choices as unknown[];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== 'string') return null;
  const t = content.trim();
  return t.length > 0 ? t : null;
}

/** 去掉 ```json ... ``` 包裹，便于容错解析 */
function stripMarkdownJsonFence(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z0-9]*\s*\n?/, '').replace(/\n?```\s*$/,'');
  }
  return t.trim();
}

function toNonNegativeFiniteNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(/,/g, ''));
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 0;
}

function toIsFoodFlag(v: unknown): 0 | 1 {
  if (v === 1 || v === true) return 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes') return 1;
  }
  return 0;
}

function toNonFoodCode(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : Number(String(v).trim());
  if (!Number.isFinite(n)) return 1;
  return Math.min(99, Math.max(0, Math.round(n)));
}

/**
 * 将模型 JSON 规范为 FoodNutritionJson；字段缺失或类型不对时补全为安全数字。
 */
export function normalizeFoodNutritionPayload(raw: unknown): { data: FoodNutritionJson; repaired: boolean } {
  let repaired = false;
  if (typeof raw !== 'object' || raw === null) {
    return { data: { ...FOOD_NUTRITION_FALLBACK }, repaired: true };
  }
  const o = raw as Record<string, unknown>;
  const is_food = toIsFoodFlag(o.is_food);
  let non_food_code = toNonFoodCode(o.non_food_code);
  let food_name =
    typeof o.food_name === 'string'
      ? o.food_name.trim()
      : o.food_name != null
        ? String(o.food_name).trim()
        : '';
  let ai_evaluation =
    typeof o.ai_evaluation === 'string'
      ? o.ai_evaluation.trim()
      : o.ai_evaluation != null
        ? String(o.ai_evaluation).trim()
        : '';
  let protein_g = toNonNegativeFiniteNumber(o.protein_g);
  let carbohydrate_g = toNonNegativeFiniteNumber(o.carbohydrate_g ?? o.carb_g ?? o.carbs_g);
  if (o.carbohydrate_g === undefined && (o.carb_g !== undefined || o.carbs_g !== undefined)) repaired = true;
  let sodium_mg = toNonNegativeFiniteNumber(o.sodium_mg ?? o.sodium);

  if (is_food === 1) {
    if (non_food_code !== 0) repaired = true;
    non_food_code = 0;
  } else {
    if (non_food_code < 1 || non_food_code > 3) {
      non_food_code = non_food_code < 1 ? 1 : 3;
      repaired = true;
    }
    protein_g = 0;
    carbohydrate_g = 0;
    sodium_mg = 0;
    food_name = '';
    ai_evaluation = '';
  }

  return {
    data: { is_food, non_food_code, food_name, ai_evaluation, protein_g, carbohydrate_g, sodium_mg },
    repaired,
  };
}

const FOOD_NUTRITION_SCHEMA_TEXT = `只输出一个 JSON 对象，禁止 markdown、禁止注释。
字段与含义：
- is_food：1=图中主要是可辨识的食物或可估算的菜品；0=明显非食物、无法辨认、无食物等。
- non_food_code：当 is_food 为 1 时必须为 0；当 is_food 为 0 时必须为 1～3 的整数（1=明显非食物场景 2=无法识别或不清晰 3=过于混杂无法对单一食物估算）。
- food_name：当 is_food 为 1 时填写具体中文名称（可含主要配菜或烹饪方式，如「清炒西兰花配鸡胸肉」，约 8～30 字）；is_food 为 0 时填空字符串 ""。
- ai_evaluation：当 is_food 为 1 时按下列要求填写；is_food 为 0 时填空字符串 ""。
${FOOD_INTAKE_AI_EVALUATION_GUIDE}
- protein_g、carbohydrate_g、sodium_mg：数字类型，非负；is_food 为 0 时三者均为 0。
估算以「图中呈现的一份/一盘/可见主体」为基准；若无法合理估算则置 is_food=0 并设置 non_food_code，food_name 与 ai_evaluation 为空字符串，营养字段为 0。`;

/**
 * 分析图片中食物的蛋白质、碳水、钠；强制 JSON 数字字段；非食物走 is_food=0。
 * 含 1305 重试、JSON 解析失败重试、结果归一化与失败兜底。
 */
export async function analyzeFoodNutritionFromImage(
  options: AnalyzeFoodNutritionOptions,
): Promise<AnalyzeFoodNutritionResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 40);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  const key = options.apiKey.trim();
  if (!key) {
    return { ok: false, error: '未配置 API 密钥', attempts: 0, data: { ...FOOD_NUTRITION_FALLBACK } };
  }
  const rawB64 = options.imageBase64?.trim() ?? '';
  if (!rawB64) {
    return { ok: false, error: '图片数据为空', attempts: 0, data: { ...FOOD_NUTRITION_FALLBACK } };
  }

  const mime = (options.imageMimeType ?? 'image/jpeg').trim() || 'image/jpeg';

  const systemContent = `你是注册营养师风格的营养成分估算助手，根据用户上传的食物照片输出 JSON。除数值字段外，food_name 与 ai_evaluation 须具体、充实，便于用户理解本餐营养与改进方向。\n${FOOD_NUTRITION_SCHEMA_TEXT}`;
  let userText =
    '请分析这张图片中的食物（若有）：估算蛋白质、碳水化合物、钠含量；输出具体的 food_name；并撰写充实、分维度完整的 ai_evaluation（勿敷衍短评），严格按系统要求的 JSON 字段与类型。';
  const extra = options.supplementText?.trim();
  if (extra) {
    userText += `\n\n用户补充说明（请结合图片与说明一起判断份量、种类与可食部分）：\n${extra}`;
  }

  const lr = await loopVisionJsonLlmWithRetries<{ data: FoodNutritionJson; repaired: boolean }>({
    apiKey: key,
    systemContent,
    userText,
    imageBase64: rawB64,
    imageMimeType: mime,
    temperature: 0.1,
    maxTokens: 4096,
    maxAttempts,
    retryDelayMs,
    zhipuVisionModel: 'glm-4.6v-flash',
    finish: parsed => {
      const { data, repaired } = normalizeFoodNutritionPayload(parsed);
      return { ok: true, value: { data, repaired } };
    },
  });

  if (!lr.ok) {
    return {
      ok: false,
      error: lr.error,
      attempts: lr.attempts,
      httpStatus: lr.httpStatus,
      data: { ...FOOD_NUTRITION_FALLBACK, non_food_code: 2 },
    };
  }

  return {
    ok: true,
    data: lr.value.data,
    attempts: lr.attempts,
    rawContent: lr.rawContent,
    repaired: lr.value.repaired,
  };
}
