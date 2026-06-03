# selfApp AI 接口使用说明书（App 端）

> 版本：1.0.0  
> 更新日期：2026-06-03  
> 适用对象：React Native / Expo 客户端开发者  
> 服务端实现：`src/services/zhipu/zhipu-image-parse.ts`（与 App 原 `lib/zhipu-image-parse.ts` 同源）

---

## 目录

1. [概述](#1-概述)
2. [接入前提](#2-接入前提)
3. [通用约定](#3-通用约定)
4. [客户端封装建议](#4-客户端封装建议)
5. [接口总览](#5-接口总览)
6. [接口详细说明](#6-接口详细说明)
   - [6.1 运维](#61-运维)
   - [6.2 健康 / 饮食](#62-健康--饮食)
   - [6.3 记账 / 财务](#63-记账--财务)
   - [6.4 心愿单](#64-心愿单)
   - [6.5 备忘](#65-备忘)
   - [6.6 项目任务](#66-项目任务)
   - [6.7 自我觉察（缺点）](#67-自我觉察缺点)
   - [6.8 每周复盘](#68-每周复盘)
   - [6.9 人格画像](#69-人格画像)
   - [6.10 目标墙](#610-目标墙)
   - [6.11 技能档案](#611-技能档案)
7. [TypeScript 类型定义](#7-typescript-类型定义)
8. [从客户端直连智谱迁移](#8-从客户端直连智谱迁移)
9. [错误处理与重试](#9-错误处理与重试)
10. [性能与限制](#10-性能与限制)
11. [附录：原函数与 App 文件对照](#11-附录原函数与-app-文件对照)

---

## 1. 概述

### 1.1 架构变化

**迁移前（旧）：**

```
App ──Bearer 智谱 Key──► open.bigmodel.cn/api/paas/v4/chat/completions
```

**迁移后（新）：**

```
App ──Bearer 业务 JWT──► 自建后端 /api/ai/*
                              │
                              └──► 智谱 API（Key 仅保存在服务端）
```

- App **不再**携带、存储或配置 `ZHIPU_API_KEY` / `EXPO_PUBLIC_ZHIPU_API_KEY`。
- App 仍使用与数据同步相同的 **Base URL** 与 **登录 Token**（见 `lib/api-config.ts`、`lib/api-client.ts`）。
- 各接口的 Prompt、JSON 归一化、1305 限流重试、请求串行队列，均在服务端完成，**响应 `data` 形状与原先客户端函数成功时的返回值一致**（可直接绑定现有 UI）。

### 1.2 基础地址

| 环境 | Base URL |
|------|----------|
| 生产默认 | `http://47.109.78.229:3000` |
| 开发 | `EXPO_PUBLIC_API_BASE_URL`（仅 `__DEV__`） |
| 用户覆盖 | 设置 → 服务器同步（AsyncStorage） |

所有 AI 接口路径前缀：**`/api/ai`**。

---

## 2. 接入前提

### 2.1 登录获取 Token

与 `/api/data/*` 完全相同：

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "<你的密码>"
}
```

**成功响应：**

```json
{
  "code": 0,
  "message": "登录成功",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

后续所有 `/api/ai/*` 请求头：

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Token 有效期 **7 天**（与数据接口一致），过期返回 HTTP `401`，`message` 为「登录已过期，请重新登录」。

### 2.2 无需智谱密钥

服务端已配置智谱 API Key，App 侧 **禁止** 再传 `apiKey`、`ZHIPU_API_KEY` 等字段。

---

## 3. 通用约定

### 3.1 统一响应信封

与 `API.md` 中数据接口 **完全一致**：

**成功：**

```json
{
  "code": 0,
  "message": "ok",
  "data": { }
}
```

**失败：**

```json
{
  "code": -1,
  "message": "可读的中文错误说明",
  "data": null
}
```

**判断规则：** `response.code === 0` 为成功；否则用 `message` 提示用户。

### 3.2 HTTP 方法

| 类型 | 方法 |
|------|------|
| 连通性探测 | `GET` |
| 其余 18 个业务接口 | `POST` |

请求体均为 JSON（`Content-Type: application/json`），UTF-8。

### 3.3 请求体大小

服务端 `express.json` 限制 **10MB**。图片类接口传 Base64 时注意压缩；可只传纯 Base64（无 `data:image/...;base64,` 前缀），并配合 `image_mime_type`。

### 3.4 上下文由 App 组装

服务端 **不** 读取用户 SQLite，只接收 App 拼好的中文摘要字符串（与迁移前传给 `parseXxxFromText({ summaryText / contextText / ... })` 的内容相同）。请继续复用现有 `build*SummaryText`、`buildPersonaContextText` 等函数。

### 3.5 耗时预期

- 文本类：通常 **3～15 秒**（含智谱 1305 自动重试）。
- 视觉类（识图 / 截图 OCR）：通常 **5～30 秒**。
- 服务端对智谱请求 **全局串行** + 每次间隔 200～300ms，并发多路 AI 会排队，UI 务必有 Loading，避免重复提交。

---

## 4. 客户端封装建议

在 `lib/ai-api-client.ts`（新建）中复用 `apiRequest`，示例：

```typescript
import { apiRequest } from './api-client';
import type { FoodTextIntakeJson } from './types/ai'; // 可从原 zhipu 类型导出

/** 所有 AI 接口统一前缀 */
const AI_PREFIX = '/api/ai';

export async function aiFoodIntakeFromText(body: {
  text: string;
  question?: string;
}): Promise<FoodTextIntakeJson> {
  return apiRequest<FoodTextIntakeJson>(`${AI_PREFIX}/food/intake-from-text`, {
    method: 'POST',
    body,
  });
}

export async function aiHealthProbe(): Promise<{
  ok: boolean;
  model: string;
  latency_ms: number;
}> {
  return apiRequest(`${AI_PREFIX}/health`, { method: 'GET' });
}
```

**替换模式（以账单分析为例）：**

```typescript
// 旧
const r = await analyzeFinanceBillSummaryFromText({
  apiKey: getActiveAiLlmApiKey(),
  summaryText: billSummaryForAi,
});
if (!r.ok) throw new Error(r.error);
const analysis = r.analysis;

// 新
const { analysis } = await apiRequest<{ analysis: string }>(
  '/api/ai/finance/bill-summary-analysis',
  { method: 'POST', body: { summary_text: billSummaryForAi } },
);
```

注意：新接口成功时 **直接返回 `data`**（由 `apiRequest` 解包），不再有 `{ ok: true, ... }` 外壳；失败时 `apiRequest` 应抛错或返回 rejected Promise（与现有数据接口一致）。

---

## 5. 接口总览

| # | 方法 | 路径 | 原客户端函数 | App 典型场景 |
|---|------|------|--------------|--------------|
| 1 | GET | `/api/ai/health` | `probeZhipuTextConnectivity` | 设置页 AI 服务状态 |
| 2 | POST | `/api/ai/food/intake-from-text` | `parseFoodIntakeFromText` | 文字记饮食 |
| 3 | POST | `/api/ai/food/nutrition-from-image` | `analyzeFoodNutritionFromImage` | 拍照识营养 |
| 4 | POST | `/api/ai/food/daily-targets` | `estimateDailyIntakeTargetsFromContext` | 首页智能摄入目标 |
| 5 | POST | `/api/ai/finance/parse-one-liner` | `parseFinanceOneLinerFromText` | 一句话记账 |
| 6 | POST | `/api/ai/finance/parse-one-liner-from-image` | `parseFinanceOneLinerFromImage` | 截图记账 |
| 7 | POST | `/api/ai/finance/txn-comment` | `analyzeFinanceTxnCommentFromText` | 流水 AI 短评 |
| 8 | POST | `/api/ai/finance/bill-summary-analysis` | `analyzeFinanceBillSummaryFromText` | 账单统计 AI |
| 9 | POST | `/api/ai/finance/dashboard-analysis` | `analyzeAiFinanceDashboardFromText` | AI 财务分析页 |
| 10 | POST | `/api/ai/finance/cash-flow-analysis` | `analyzeCashFlowDashboardFromText` | 现金流图 AI |
| 11 | POST | `/api/ai/wish-list/rational-review` | `analyzeWishListRationalReviewFromText` | 心愿清单理性评审 |
| 12 | POST | `/api/ai/wish-item/comment` | `analyzeWishItemAiCommentFromText` | 单条心愿点评 |
| 13 | POST | `/api/ai/memo/review` | `analyzeMemoReviewFromText` | 备忘 AI 评价 |
| 14 | POST | `/api/ai/project/tasks-review` | `analyzeProjectTasksReviewFromText` | 项目任务点评 |
| 15 | POST | `/api/ai/weakness/review` | `analyzeWeaknessReviewFromText` | 缺点分析 |
| 16 | POST | `/api/ai/weekly-review/coaching` | `generateWeeklyReviewCoachingFromText` | 周复盘教练 |
| 17 | POST | `/api/ai/persona/portrait` | `generatePersonaPortraitFromContext` | 人格画像 |
| 18 | POST | `/api/ai/vision-wall/assessment` | `analyzeVisionWallGoalsFromText` | 目标墙评估 |
| 19 | POST | `/api/ai/skills/portfolio` | `analyzeUserSkillsPortfolioFromText` | 技能组合评估 |

---

## 6. 接口详细说明

以下 `BASE` 表示：`{API_BASE_URL}`，例如 `http://47.109.78.229:3000`。

---

### 6.1 运维

#### GET `/api/ai/health`

**说明：** 探测后端 → 智谱链路是否可用，替代原 `probeZhipuTextConnectivity`。设置页「AI 服务状态」可调用此接口。

**请求头：** `Authorization: Bearer <token>`

**请求体：** 无

**成功 `data`：**

```json
{
  "ok": true,
  "model": "glm-4-flash",
  "latency_ms": 842
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 恒为 `true`（失败走 HTTP 错误信封） |
| `model` | string | 探测使用的文本模型 |
| `latency_ms` | number | 端到端耗时（毫秒） |

**失败 `message` 示例：** 「智谱连通性探测失败」、智谱返回的具体错误文案。

---

### 6.2 健康 / 饮食

#### POST `/api/ai/food/intake-from-text`

**原函数：** `parseFoodIntakeFromText`

**App 调用位置：** `app/(tabs)/index.tsx`、`components/record-intake-sheet.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 用户饮食文字描述 |
| `question` | string | 否 | 追加问题；不传时服务端使用默认引导语 |

**请求示例：**

```json
{
  "text": "午饭吃了牛肉面一碗，加卤蛋，没喝汤",
  "question": "请完整分析这段饮食描述并估算营养"
}
```

**成功 `data`（`FoodTextIntakeJson`）：**

```json
{
  "food_summary": "牛肉面一碗配卤蛋，无汤饮",
  "hydration_ml": 0,
  "protein_g": 28,
  "carbohydrate_g": 65,
  "sodium_mg": 1200,
  "ai_evaluation": "（120～400 字中文营养点评，自然段，无 markdown）"
}
```

| 字段 | 说明 |
|------|------|
| `hydration_ml` | 仅计汤/粥/饮料/水果等；正餐固体不计隐性水分 |
| `ai_evaluation` | 须充实，涵盖识别概要、营养结构、注意点、可行建议 |

**存储：** 健康记录 `intake_ai_comment` 等字段。

---

#### POST `/api/ai/food/nutrition-from-image`

**原函数：** `analyzeFoodNutritionFromImage`

**App 调用位置：** `app/(tabs)/index.tsx`、`app/zhipu-api-test.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `image_base64` | string | 是 | 图片 Base64；可带或不带 `data:image/jpeg;base64,` 前缀 |
| `image_mime_type` | string | 否 | 默认 `image/jpeg`；常见 `image/png`、`image/webp` |
| `supplement_text` | string | 否 | 用户补充说明（份量、菜名等） |

**成功 `data`（`FoodNutritionJson`）：**

```json
{
  "is_food": 1,
  "non_food_code": 0,
  "food_name": "清炒西兰花配鸡胸肉",
  "ai_evaluation": "（120～400 字点评）",
  "protein_g": 25,
  "carbohydrate_g": 12,
  "sodium_mg": 380
}
```

| 字段 | 说明 |
|------|------|
| `is_food` | `1` 可识别食物；`0` 非食物 |
| `non_food_code` | `is_food=1` 时为 `0`；`is_food=0` 时为 `1～3`（1 明显非食物 / 2 无法识别 / 3 过于混杂） |
| `food_name` / `ai_evaluation` | `is_food=0` 时为空字符串 |
| `protein_g` 等 | `is_food=0` 时为 `0` |

---

#### POST `/api/ai/food/daily-targets`

**原函数：** `estimateDailyIntakeTargetsFromContext`

**App 调用位置：** `lib/daily-intake-ai-targets.ts` ← 首页、画像刷新

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `context_block` | string | 是 | 用户档案 + 近 7 日摄入 + 本地公式参考值等中文摘要 |

**成功 `data`（`DailyIntakeTargetsEstimateJson`）：**

```json
{
  "hydration_ml": 2200,
  "protein_g": 85,
  "carbohydrate_g": 260,
  "sodium_mg": 2200,
  "rationale_zh": "结合近七日蛋白偏低与今日健身日，适度上调蛋白与钠。"
}
```

| 字段 | 说明 |
|------|------|
| `rationale_zh` | 可选，1～2 句调整依据 |
| 数值范围 | 服务端会 clamp 到合理区间（如水分约 800～5000 ml） |

**缓存：** 按用户档案指纹本地缓存（逻辑不变）。

---

### 6.3 记账 / 财务

#### POST `/api/ai/finance/parse-one-liner`

**原函数：** `parseFinanceOneLinerFromText`

**App 调用位置：** `app/(tabs)/finance.tsx`、`hooks/use-finance-transaction-sheet-controller.ts`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 用户一句话记账（中文） |
| `accounts` | array | 否 | `[{ "name": "支付宝", "account_no": "1234" }]`，供匹配 `account_name` |

**成功 `data`：**

```json
{
  "transaction_type": "expense",
  "amount": 28.5,
  "name": "午饭",
  "category_label": "餐饮",
  "payment_account_label": "支付宝",
  "account_name": "支付宝"
}
```

| 字段 | 说明 |
|------|------|
| `transaction_type` | `"expense"` \| `"income"` |
| `category_label` | 无法推断时为 `null` |
| `amount` | 须 > 0；无法解析时接口失败 |

**注意：** 无 `is_bill` 字段（仅截图版有）。

---

#### POST `/api/ai/finance/parse-one-liner-from-image`

**原函数：** `parseFinanceOneLinerFromImage`

**App 调用位置：** `finance.tsx`、`lib/auto-ledger-runner.ts`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `image_base64` | string | 是 | 支付/账单截图 Base64 |
| `image_mime_type` | string | 否 | 默认 `image/jpeg` |
| `accounts` | array | 否 | 同「一句话记账」 |

**成功 `data`：** 与上一接口相同，并 **固定包含**：

```json
{
  "is_bill": true,
  "transaction_type": "expense",
  "amount": 99,
  "name": "超市购物",
  "category_label": "购物",
  "payment_account_label": "花呗",
  "account_name": "支付宝"
}
```

**典型失败 `message`：**

- `这不是账单或支付凭证截图`（模型判定 `is_bill=false`）
- `未能从截图中识别出有效金额与标题`

---

#### POST `/api/ai/finance/txn-comment`

**原函数：** `analyzeFinanceTxnCommentFromText`

**App 调用位置：** `lib/repositories/finance/finance-txn-ai-comment.ts`（保存流水后后台）

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `summary_text` | string | 是 | 单条流水中文摘要 |

**成功 `data`：**

```json
{
  "comment": "这笔餐饮支出频率偏高，可留意本月预算。"
}
```

| 字段 | 说明 |
|------|------|
| `comment` | 约 20～40 字，最多约 80 字 |

**存储：** `finance_transactions.ai_comment`

---

#### POST `/api/ai/finance/bill-summary-analysis`

**原函数：** `analyzeFinanceBillSummaryFromText`

**App 调用位置：** `app/finance-stats.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `summary_text` | string | 是 | 账单统计页聚合摘要 |

**成功 `data`：**

```json
{
  "analysis": "（300～400 字结构化中文财务分析）"
}
```

---

#### POST `/api/ai/finance/dashboard-analysis`

**原函数：** `analyzeAiFinanceDashboardFromText`

**App 调用位置：** `app/ai-finance-analysis.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `summary_text` | string | 是 | 本月汇总 + 分类 + 趋势 + 可选现金流图段落 |
| `past6_net_savings` | number[6] | 否 | 过去 6 个月每月净储蓄（元，旧→新），用于约束预测曲线 |
| `past6_income` | number[6] | 否 | 过去 6 个月每月收入合计 |

**成功 `data`（`AiFinanceDashboardPayload`）：**

```json
{
  "health_score": 72,
  "health_summary": "收支基本平衡，储蓄率有提升空间。",
  "insights": [
    { "title": "储蓄率承压", "body": "（300～400 字）" },
    { "title": "固定支出占比偏高", "body": "（300～400 字）" }
  ],
  "expense_breakdown_comment": "餐饮与交通占比较高…",
  "savings_forecast_12": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "income_forecast_12": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "surplus_forecast_12": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}
```

| 字段 | 说明 |
|------|------|
| `insights` | **恰好 2 条**，`body` 各 300～400 字 |
| `*_forecast_12` | 长度 **12**：索引 0～5 历史（5=本月），6～11 预测 |

---

#### POST `/api/ai/finance/cash-flow-analysis`

**原函数：** `analyzeCashFlowDashboardFromText`

**App 调用位置：** `app/cash-flow/cash-flow-ui.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `summary_text` | string | 是 | 现金流图页本地数据摘要 |

**成功 `data`：**

```json
{
  "analysis": "（300～400 字）"
}
```

---

### 6.4 心愿单

#### POST `/api/ai/wish-list/rational-review`

**原函数：** `analyzeWishListRationalReviewFromText`

**App 调用位置：** `app/wish-list.tsx`（列表变化后自动，有本地缓存）

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `context_text` | string | 是 | 心愿清单聚合上下文 |

**成功 `data`：**

```json
{
  "headline": "高心动高价条目偏多",
  "review": "（300～400 字理性消费评审正文）"
}
```

| 字段 | 说明 |
|------|------|
| `headline` | ≤24 字 |
| `review` | 300～400 字 |

**缓存键：** `wish-list-rational-ai-cache`

---

#### POST `/api/ai/wish-item/comment`

**原函数：** `analyzeWishItemAiCommentFromText`

**App 调用位置：** `lib/repositories/wish-list/wish-item-ai-comment.ts`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `summary_text` | string | 是 | 单条心愿摘要 |

**成功 `data`：**

```json
{
  "comment": "（80～260 字点评）"
}
```

**存储：** `wish_items.ai_comment`

---

### 6.5 备忘

#### POST `/api/ai/memo/review`

**原函数：** `analyzeMemoReviewFromText`

**App 调用位置：** `lib/memo-ai-background.ts`、`app/memo-list.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `memo_context_text` | string | 是 | 备忘元信息 + 标题 + 正文格式化文本 |

**成功 `data`：**

```json
{
  "evaluation": "（300～400 字评价）",
  "suggestions": "（250～400 字建议，换行或分号分隔多条）"
}
```

**存储：** `memos.ai_evaluation`、`memos.ai_suggestions`

---

### 6.6 项目任务

#### POST `/api/ai/project/tasks-review`

**原函数：** `analyzeProjectTasksReviewFromText`

**App 调用位置：** `lib/project-ai-review-background.ts`、`app/edit-project.tsx`、`app/(tabs)/tasks.tsx`

**触发：** **仅用户手动**点击「开始分析 / 重新分析」（保存项目时不要自动调；`startProjectAiReviewInBackground` 已 `@deprecated`）。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `project_context_text` | string | 是 | 项目 + 全部任务摘要 |

**成功 `data`：**

```json
{
  "evaluation": "（100～280 字整体点评）",
  "suggestions": "（120～500 字行动建议）"
}
```

**存储：** `projects.extra_data.ai_review`

---

### 6.7 自我觉察（缺点）

#### POST `/api/ai/weakness/review`

**原函数：** `analyzeWeaknessReviewFromText`

**App 调用位置：** `lib/weakness-ai-background.ts`、`app/weakness-list.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `weakness_context_text` | string | 是 | 缺点名称 + 详情格式化文本 |

**成功 `data`：** 与备忘相同结构 `{ evaluation, suggestions }`（字段名一致，文案风格为自我觉察陪练）。

---

### 6.8 每周复盘

#### POST `/api/ai/weekly-review/coaching`

**原函数：** `generateWeeklyReviewCoachingFromText`

**App 调用位置：** `lib/weekly-review-coaching.ts`、`app/weekly-review.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_prompt` | string | 是 | 用户周复盘原文 + 可选近 7 日每日复盘拼接 |

**成功 `data`：**

```json
{
  "text": "【总览】\n…\n【对齐用户写下的重点】\n…\n【数据侧参考】\n…\n【建议与修正提醒】\n…\n【下周可做的一件事】\n…\n【温和结语】\n…"
}
```

**说明：** 纯文本（非 JSON）。须包含以下 **逐字** 小节标题：

1. `【总览】`
2. `【对齐用户写下的重点】`
3. `【数据侧参考】`
4. `【建议与修正提醒】`
5. `【下周可做的一件事】`
6. `【温和结语】`

无 Key 时 App 可继续走本地规则兜底（逻辑不变）。

---

### 6.9 人格画像

#### POST `/api/ai/persona/portrait`

**原函数：** `generatePersonaPortraitFromContext`

**App 调用位置：** `lib/persona-portrait-sync.ts`、`app/persona-detail/[slug].tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `persona_slug` | string | 是 | 见下表 |
| `context_text` | string | 是 | 本地数据摘要（中文） |

**`persona_slug` 取值：**

| slug | 侧重点 |
|------|--------|
| `plan-completion` | 任务完成、习惯、青蛙优先级 |
| `health` | 身体档案、四营养维度、周环比 |
| `savings` | 储蓄、记账、延迟满足 |
| `ai-insight` | 综合总评式洞察 |

**成功 `data`（`PersonaPortraitAiData`）：**

```json
{
  "hero_kicker": "",
  "hero_main": "",
  "hero_caption": "",
  "overview": "",
  "bullets": ["（4～6 条，每条 35～90 字）"],
  "stats": [{ "label": "", "value": "", "hint": "" }],
  "milestones": [],
  "dims": [{ "title": "", "sub": "" }],
  "ai_quote": ""
}
```

**缓存：** SQLite `persona_portrait_cache`（按 slug + 档案指纹）。

---

### 6.10 目标墙

#### POST `/api/ai/vision-wall/assessment`

**原函数：** `analyzeVisionWallGoalsFromText`

**App 调用位置：** `app/vision-wall.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `plan_digest_text` | string | 是 | 各计划进度、截止日、剩余时间等摘要 |
| `expected_goal_ids` | string[] | 是 | 须评估的 `goal_id` 列表，非空；服务端按此回填 `per_goal` |
| `user_display_name` | string | 否 | 用户称呼，默认「用户」 |

**成功 `data`（`VisionWallAiAssessmentPayload`）：**

```json
{
  "feasibility_score": 72,
  "headline": "一句总评",
  "sections": [
    { "title": "总体可行性评估", "body": "（≥220 字）" },
    { "title": "时间与节奏诊断", "body": "…" },
    { "title": "目标组合与资源冲突", "body": "…" },
    { "title": "优化建议与行动路径", "body": "…" }
  ],
  "per_goal": [
    {
      "goal_id": "goal_001",
      "title": "存钱 5 万",
      "feasibility_level": "中等",
      "remain_assessment": "…",
      "optimization": "…"
    }
  ],
  "closing_summary": "（≥280 字收尾）"
}
```

**缓存键：** `vision_wall_ai_assessment_v1`

---

### 6.11 技能档案

#### POST `/api/ai/skills/portfolio`

**原函数：** `analyzeUserSkillsPortfolioFromText`

**App 调用位置：** `app/my-skills.tsx`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_display_name` | string | 是 | 展示称呼 |
| `lines` | array | 是 | 至少 1 条有效技能；每条须含非空 `skill_id` |

**`lines[]` 元素：**

| 字段 | 类型 | 必填 |
|------|------|------|
| `skill_id` | string | 是 |
| `dimension` | string | 建议填 |
| `name` | string | 建议填 |
| `description` | string | 建议填 |

服务端会过滤 `skill_id` 为空的行；若过滤后为空，返回 `lines 中至少包含一条有效 skill_id`。

**成功 `data`（`UserSkillAiPortfolioPayload`）：**

```json
{
  "per_skill": [
    {
      "skill_id": "sk_01",
      "evaluation": "（150～220 字）",
      "suggestions": "（120～200 字）"
    }
  ],
  "overall_suggestions": "（280～400 字）",
  "profile_analysis": "（300～400 字）"
}
```

`per_skill` 顺序与请求中的 `skill_id` 一致，缺失条目会有占位文案。

---

## 7. TypeScript 类型定义

可将以下类型放入 `lib/types/ai-api.ts`，与 UI 绑定：

```typescript
export type FoodTextIntakeJson = {
  food_summary: string;
  hydration_ml: number;
  protein_g: number;
  carbohydrate_g: number;
  sodium_mg: number;
  ai_evaluation: string;
};

export type FoodNutritionJson = {
  is_food: 0 | 1;
  non_food_code: number;
  food_name: string;
  ai_evaluation: string;
  protein_g: number;
  carbohydrate_g: number;
  sodium_mg: number;
};

export type DailyIntakeTargetsEstimateJson = {
  hydration_ml: number;
  protein_g: number;
  carbohydrate_g: number;
  sodium_mg: number;
  rationale_zh?: string;
};

export type FinanceOneLinerJson = {
  transaction_type: 'expense' | 'income';
  amount: number;
  name: string;
  category_label: string | null;
  payment_account_label: string | null;
  account_name: string | null;
  is_bill?: boolean;
};

export type AiFinanceDashboardPayload = {
  health_score: number;
  health_summary: string;
  insights: [{ title: string; body: string }, { title: string; body: string }];
  expense_breakdown_comment: string;
  savings_forecast_12: number[];
  income_forecast_12: number[];
  surplus_forecast_12: number[];
};

export type PersonaPortraitAiData = {
  hero_kicker: string;
  hero_main: string;
  hero_caption: string;
  overview: string;
  bullets: string[];
  stats: { label: string; value: string; hint: string }[];
  milestones: string[];
  dims: { title: string; sub: string }[];
  ai_quote: string;
};

export type VisionWallAiAssessmentPayload = {
  feasibility_score: number;
  headline: string;
  sections: { title: string; body: string }[];
  per_goal: {
    goal_id: string;
    title: string;
    feasibility_level: string;
    remain_assessment: string;
    optimization: string;
  }[];
  closing_summary: string;
};

export type UserSkillAiPortfolioPayload = {
  per_skill: { skill_id: string; evaluation: string; suggestions: string }[];
  overall_suggestions: string;
  profile_analysis: string;
};
```

---

## 8. 从客户端直连智谱迁移

### 8.1 必改项

| 项 | 操作 |
|----|------|
| 智谱 API Key | 删除 `ZHIPU_EMBEDDED_API_KEY`、`getActiveAiLlmApiKey()`、设置页 Key 输入 |
| `lib/zhipu-image-parse.ts` | 改为调用 `/api/ai/*`，或拆出 `lib/ai-api-client.ts` |
| 函数返回值 | 旧：`{ ok, data/error }`；新：`apiRequest` 成功直接得 `data`，失败抛错 |
| 截图记账 | `imageDataUri` 改为 POST `image_base64` + `image_mime_type` |
| 连通性测试 | `probeZhipuTextConnectivity` → `GET /api/ai/health` |

### 8.2 不必改项

- 各页面的 **摘要拼装函数**（`buildBillSummaryForAi` 等）保持原样，只改调用目标 URL。
- 本地 **缓存键、SQLite 字段、UI 文案长度** 不变。
- 周复盘 **无网络时本地规则兜底** 可保留。

### 8.3 推荐迁移顺序

1. **P0：** 一句话记账、截图记账、流水短评、饮食文字/识图  
2. **P1：** 备忘、缺点、心愿短评、人格画像、首页摄入目标  
3. **P2：** 账单分析、AI 财务页、现金流、目标墙、技能、周复盘、项目点评  

### 8.4 curl 自测示例

```bash
# 1. 登录
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的密码"}' \
  | jq -r '.data.token')

# 2. AI 健康检查
curl -s http://127.0.0.1:3000/api/ai/health \
  -H "Authorization: Bearer $TOKEN" | jq

# 3. 一句话记账
curl -s -X POST http://127.0.0.1:3000/api/ai/finance/parse-one-liner \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"午饭外卖28元支付宝"}' | jq
```

---

## 9. 错误处理与重试

### 9.1 HTTP 状态码

| HTTP | 典型场景 |
|------|----------|
| `200` + `code: 0` | 成功 |
| `200` + `code: -1` | 业务失败（参数空、智谱返回无效 JSON、截图非账单等） |
| `400` | 参数校验失败（如 `text 不能为空`） |
| `401` | 未登录或 Token 过期 |
| `502` | 智谱 API 错误或 AI 处理失败 |
| `500` | 服务端未捕获异常 |

### 9.2 App 侧建议

```typescript
try {
  const data = await aiFoodIntakeFromText({ text: userText });
  // 使用 data
} catch (e) {
  if (e instanceof ApiRequestError) {
    if (e.status === 401) {
      // 跳转登录
    } else {
      Alert.alert('AI 暂时不可用', e.message);
    }
  }
}
```

- **不要**在 App 对 1305 限流做重试（服务端已重试最多数十次）。
- 用户取消或切换页面时，用 `AbortController` 取消 fetch（若 `apiRequest` 支持 signal）。
- 同屏避免连续触发多个 AI 请求（服务端串行，后发的会长时间等待）。

### 9.3 常见 `message` 文案

| message | 含义 |
|---------|------|
| `text 不能为空` | 必填字符串未传或全空白 |
| `image_base64 不能为空` | 图片未传 |
| `expected_goal_ids 必须为非空数组` | 目标墙未传 goal id |
| `这不是账单或支付凭证截图` | 截图记账判定非账单 |
| `未能从话中解析出有效金额与标题` | 一句话记账无有效金额 |
| `模型返回的不是合法 JSON` | 智谱输出异常（已重试仍失败） |
| `登录已过期，请重新登录` | Token 失效 |

---

## 10. 性能与限制

| 项 | 说明 |
|----|------|
| 请求体上限 | 10MB（JSON） |
| 智谱模型 | 文本 `glm-4-flash`；视觉 `glm-4.6v-flash` |
| 服务端队列 | 全局串行，单次 AI 完成后随机等待 200～300ms |
| 1305 重试 | 服务端自动处理，App 无需实现 |
| 超时 | 建议 App `fetch` 超时 **60～120 秒**（视觉接口） |
| 隐私 | 仅传 App 组装的摘要与图片 Base64，不传数据库全表 |

---

## 11. 附录：原函数与 App 文件对照

| 服务端路径 | 原 `lib/zhipu-image-parse.ts` 函数 | 相关 App 文件 |
|------------|-----------------------------------|---------------|
| `GET /api/ai/health` | `probeZhipuTextConnectivity` | `components/settings-drawer/global-settings-panel.tsx` |
| `POST .../food/intake-from-text` | `parseFoodIntakeFromText` | `index.tsx`, `record-intake-sheet.tsx` |
| `POST .../food/nutrition-from-image` | `analyzeFoodNutritionFromImage` | `index.tsx`, `zhipu-api-test.tsx` |
| `POST .../food/daily-targets` | `estimateDailyIntakeTargetsFromContext` | `daily-intake-ai-targets.ts` |
| `POST .../finance/parse-one-liner` | `parseFinanceOneLinerFromText` | `finance.tsx`, `use-finance-transaction-sheet-controller.ts` |
| `POST .../finance/parse-one-liner-from-image` | `parseFinanceOneLinerFromImage` | `finance.tsx`, `auto-ledger-runner.ts` |
| `POST .../finance/txn-comment` | `analyzeFinanceTxnCommentFromText` | `finance-txn-ai-comment.ts` |
| `POST .../finance/bill-summary-analysis` | `analyzeFinanceBillSummaryFromText` | `finance-stats.tsx` |
| `POST .../finance/dashboard-analysis` | `analyzeAiFinanceDashboardFromText` | `ai-finance-analysis.tsx` |
| `POST .../finance/cash-flow-analysis` | `analyzeCashFlowDashboardFromText` | `cash-flow-ui.tsx` |
| `POST .../wish-list/rational-review` | `analyzeWishListRationalReviewFromText` | `wish-list.tsx` |
| `POST .../wish-item/comment` | `analyzeWishItemAiCommentFromText` | `wish-item-ai-comment.ts` |
| `POST .../memo/review` | `analyzeMemoReviewFromText` | `memo-ai-background.ts`, `memo-list.tsx` |
| `POST .../project/tasks-review` | `analyzeProjectTasksReviewFromText` | `project-ai-review-background.ts`, `edit-project.tsx` |
| `POST .../weakness/review` | `analyzeWeaknessReviewFromText` | `weakness-ai-background.ts` |
| `POST .../weekly-review/coaching` | `generateWeeklyReviewCoachingFromText` | `weekly-review-coaching.ts` |
| `POST .../persona/portrait` | `generatePersonaPortraitFromContext` | `persona-portrait-sync.ts` |
| `POST .../vision-wall/assessment` | `analyzeVisionWallGoalsFromText` | `vision-wall.tsx` |
| `POST .../skills/portfolio` | `analyzeUserSkillsPortfolioFromText` | `my-skills.tsx` |

---

**相关文档：**

- 数据接口：`API.md`
- 后端需求与能力梳理：`AI_BACKEND_REQUIREMENTS.md`
