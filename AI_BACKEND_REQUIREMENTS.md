# AI 能力梳理与后端接口需求

> 文档目的：汇总当前 App **客户端直连智谱 AI** 的全部使用点，供后端接管密钥与请求；并告知现有 API 地址与密钥配置。  
> 生成日期：2026-06-03  
> 核心实现文件：`lib/zhipu-image-parse.ts`（约 3000 行，含全部 Prompt、JSON 归一化与重试逻辑）

---

## 1. 现状概述

### 1.1 架构

```
┌─────────────┐     HTTPS (Bearer 智谱 Key)      ┌──────────────────────────────┐
│  React Native │ ──────────────────────────────► │ open.bigmodel.cn             │
│  App 客户端   │   POST /api/paas/v4/chat/       │ /api/paas/v4/chat/completions│
└─────────────┘   completions                     └──────────────────────────────┘
       │
       │  HTTPS (Bearer 业务 Token) — 仅数据同步，与 AI 无关
       ▼
┌──────────────────────────────┐
│ 自建 REST 后端                │
│ http://47.109.78.229:3000    │
│ /api/auth/login、/api/data/* │
└──────────────────────────────┘
```

- **AI 请求**：目前全部在客户端发起，密钥写在 App 内或通过 Expo 环境变量注入。
- **业务数据**：已通过 `lib/api-client.ts` 对接自建 MySQL REST 后端（登录 + CRUD），**尚未**有 AI 代理接口。
- **迁移目标**：智谱 API Key 仅保存在后端；App 只传脱敏后的上下文摘要 / 图片 Base64，由后端调用智谱并返回与现客户端一致的 JSON 结构。

### 1.2 智谱 API（当前客户端直连）

| 项 | 值 |
|---|---|
| **接口地址** | `https://open.bigmodel.cn/api/paas/v4/chat/completions` |
| **请求方法** | `POST` |
| **鉴权 Header** | `Authorization: Bearer <ZHIPU_API_KEY>` |
| **Content-Type** | `application/json` |
| **文本模型** | `glm-4-flash`（绝大多数场景） |
| **视觉模型** | `glm-4.6v-flash`（食物识图、账单截图 OCR） |
| **JSON 模式** | 多数接口设置 `response_format: { "type": "json_object" }` |
| **限流处理** | 智谱错误码 `1305` 时自动重试；客户端全局串行队列，每次请求结束后随机 sleep 200～300ms |

### 1.3 智谱 API Key（请后端配置，勿再下发客户端）

| 来源 | 说明 |
|---|---|
| **环境变量（优先）** | `EXPO_PUBLIC_ZHIPU_API_KEY` — Expo 构建/开发时注入，便于轮换密钥 |
| **App 内置兜底** | `d0ab5a5e402040d291d9b77f58996d32.nL1sXtGfaUMXzW7W`（定义于 `lib/zhipu-image-parse.ts` 常量 `ZHIPU_EMBEDDED_API_KEY`） |

> **安全提示**：内置密钥已随 App 分发，迁移后应轮换智谱 Key，并仅在后端环境变量中保存新 Key。

### 1.4 App 业务 REST 后端（数据同步，非 AI）

配置见 `lib/api-config.ts`，供后端同学了解 App 已对接的服务：

| 项 | 值 |
|---|---|
| **默认 Base URL** | `http://47.109.78.229:3000` |
| **开发环境变量** | `EXPO_PUBLIC_API_BASE_URL`（仅 `__DEV__` 时读取） |
| **用户可覆盖** | 设置 → 服务器同步（AsyncStorage） |
| **默认登录账号** | `admin` |
| **默认登录密码** | `zhen8907146` |
| **登录接口** | `POST /api/auth/login` → `{ code, message, data: { token } }` |
| **数据接口** | `GET/POST/PUT/PATCH/DELETE /api/data/{table}[/{id}]` |
| **表元数据** | `GET /api/tables` |
| **鉴权** | `Authorization: Bearer <业务 token>` |

### 1.5 其他云端地址（与 AI 无关，供参考）

| 服务 | 地址 / 密钥 | 用途 |
|---|---|---|
| Cloudflare D1 Worker | `https://odd-cloud-eae0.1594834072.workers.dev` | 云备份 SQL |
| 默认访问密钥 | `zhen8907146`（`DEFAULT_CLOUD_AUTH_TOKEN`） | Worker 鉴权 |
| 环境变量 | `EXPO_PUBLIC_CLOUD_AUTH_TOKEN` / `EXPO_PUBLIC_KV_AUTH_TOKEN` | 可覆盖内置密钥 |

---

## 2. AI 能力模块汇总

以下按 **业务域** 列出所有使用智谱的能力。函数名均来自 `lib/zhipu-image-parse.ts`。

### 2.1 健康 / 饮食

| 能力 | 智谱函数 | 模型 | 调用位置 | 触发方式 | 结果存储 |
|---|---|---|---|---|---|
| **文字描述估算一餐营养** | `parseFoodIntakeFromText` | glm-4-flash | `app/(tabs)/index.tsx`、`components/record-intake-sheet.tsx` | 用户提交饮食文字 | 健康记录 `intake_ai_comment` 等 |
| **拍照识图估算营养** | `analyzeFoodNutritionFromImage` | glm-4.6v-flash | `app/(tabs)/index.tsx` | 用户选图/拍照 | 同上 |
| **首页「智能建议」当日四项摄入目标** | `estimateDailyIntakeTargetsFromContext` | glm-4-flash | `lib/daily-intake-ai-targets.ts` ← `index.tsx` | 打开首页时自动（按用户档案指纹缓存） | App Settings / SQLite |
| **连通性测试（食物识图）** | `analyzeFoodNutritionFromImage` | glm-4.6v-flash | `app/zhipu-api-test.tsx` | 调试页手动 | 无 |

**`parseFoodIntakeFromText` 响应字段**（JSON `result` 内）：

```json
{
  "food_summary": "string",
  "hydration_ml": 0,
  "protein_g": 0,
  "carbohydrate_g": 0,
  "calories_kcal": 0,
  "ai_evaluation": "string（120～400字）"
}
```

**`estimateDailyIntakeTargetsFromContext` 响应字段**：

```json
{
  "hydration_ml": 0,
  "protein_g": 0,
  "carbohydrate_g": 0,
  "calories_kcal": 0,
  "rationale_zh": "string（可选）"
}
```

**`analyzeFoodNutritionFromImage` 响应字段**：

```json
{
  "is_food": 1,
  "non_food_code": 0,
  "food_name": "string",
  "ai_evaluation": "string",
  "protein_g": 0,
  "carbohydrate_g": 0,
  "calories_kcal": 0
}
```

---

### 2.2 记账 / 财务

| 能力 | 智谱函数 | 模型 | 调用位置 | 触发方式 | 结果存储 |
|---|---|---|---|---|---|
| **一句话口语记账** | `parseFinanceOneLinerFromText` | glm-4-flash | `app/(tabs)/finance.tsx`、`hooks/use-finance-transaction-sheet-controller.ts` | 用户输入一句话 | 直接填充记账表单 |
| **截图自动记账** | `parseFinanceOneLinerFromImage` → `parseImageToJson` | glm-4.6v-flash | `finance.tsx`、`lib/auto-ledger-runner.ts`（快捷指令/剪贴板） | 粘贴截图 / 快捷指令 | 自动创建流水 |
| **单条流水 AI 短评** | `analyzeFinanceTxnCommentFromText` | glm-4-flash | `lib/repositories/finance/finance-txn-ai-comment.ts` ← 保存流水时 | 保存/编辑流水后后台 | `finance_transactions.ai_comment` |
| **账单统计页 AI 分析** | `analyzeFinanceBillSummaryFromText` | glm-4-flash | `app/finance-stats.tsx` | 用户点击「生成 AI 分析」 | 页面 state（未持久化） |
| **AI 财务分析仪表盘** | `analyzeAiFinanceDashboardFromText` | glm-4-flash | `app/ai-finance-analysis.tsx` | 进入页面 / 刷新 | 页面 state |
| **现金流图 AI 分析** | `analyzeCashFlowDashboardFromText` | glm-4-flash | `app/cash-flow/cash-flow-ui.tsx` | 用户点击生成 | 页面 state |

**`parseFinanceOneLinerFromText` / 截图版 响应字段**：

```json
{
  "transaction_type": "expense | income",
  "amount": 28.5,
  "name": "午饭",
  "category_label": "餐饮 | null",
  "payment_account_label": "支付宝 | null",
  "account_name": "支付宝 | null",
  "is_bill": true
}
```

（截图版额外有 `is_bill`；非账单时 `is_bill: false`。）

**`analyzeFinanceTxnCommentFromText` 响应**：`{ "comment": "约 20～40 字" }`

**`analyzeFinanceBillSummaryFromText` / `analyzeCashFlowDashboardFromText` 响应**：`{ "analysis": "300～400 字" }`

**`analyzeAiFinanceDashboardFromText` 响应**（复杂结构，见 `AiFinanceDashboardPayload`）：

```json
{
  "health_score": 72,
  "health_summary": "string",
  "insights": [
    { "title": "string", "body": "300～400字" },
    { "title": "string", "body": "300～400字" }
  ],
  "expense_breakdown_comment": "string",
  "savings_forecast_12": [12 个数字],
  "income_forecast_12": [12 个数字],
  "surplus_forecast_12": [12 个数字]
}
```

---

### 2.3 心愿单

| 能力 | 智谱函数 | 调用位置 | 触发方式 | 结果存储 |
|---|---|---|---|---|
| **清单级理性消费评审** | `analyzeWishListRationalReviewFromText` | `app/wish-list.tsx` | 列表变化后自动（有本地缓存） | AsyncStorage `wish-list-rational-ai-cache` |
| **单条心愿 AI 点评** | `analyzeWishItemAiCommentFromText` | `lib/repositories/wish-list/wish-item-ai-comment.ts` ← 新建/编辑心愿 | 保存后后台 | `wish_items.ai_comment` |

**清单评审响应**：`{ "headline": "≤24字", "review": "300～400字" }`  
**单条点评响应**：`{ "comment": "80～260字" }`

---

### 2.4 备忘

| 能力 | 智谱函数 | 调用位置 | 触发方式 | 结果存储 |
|---|---|---|---|---|
| **备忘 AI 评价与建议** | `analyzeMemoReviewFromText` | `lib/memo-ai-background.ts`（新建后后台）、`app/memo-list.tsx`（手动重试） | 新建自动 + 列表手动 | `memos.ai_evaluation` / `ai_suggestions` |

**响应**：`{ "evaluation": "300～400字", "suggestions": "250～400字" }`

---

### 2.5 任务 / 项目

| 能力 | 智谱函数 | 调用位置 | 触发方式 | 结果存储 |
|---|---|---|---|---|
| **项目任务整体 AI 点评** | `analyzeProjectTasksReviewFromText` | `lib/project-ai-review-background.ts` ← `app/edit-project.tsx`、`app/(tabs)/tasks.tsx` | **仅用户手动**点击「开始分析/重新分析」 | `projects.extra_data.ai_review` |

**响应**：`{ "evaluation": "100～280字", "suggestions": "120～500字" }`

> 注：`startProjectAiReviewInBackground` 已标记 `@deprecated`，不应在保存项目时自动调用。

---

### 2.6 自我觉察（缺点）

| 能力 | 智谱函数 | 调用位置 | 触发方式 | 结果存储 |
|---|---|---|---|---|
| **缺点分析与改进建议** | `analyzeWeaknessReviewFromText` | `lib/weakness-ai-background.ts` ← `app/weakness-list.tsx`、编辑页保存后 | 新建后后台自动；列表可强制重试 | `user_weaknesses` 相关 AI 字段 |

**响应**：`{ "evaluation": "300～400字", "suggestions": "250～400字" }`（字段名与备忘相同）

---

### 2.7 复盘 / 教练

| 能力 | 智谱函数 | 调用位置 | 触发方式 | 结果存储 |
|---|---|---|---|---|
| **每周复盘 AI 教练建议** | `generateWeeklyReviewCoachingFromText` | `lib/weekly-review-coaching.ts` ← `app/weekly-review.tsx` | 用户点击生成；无 Key 时走本地规则 | 复盘记录字段 |
| **智谱连通性探测** | `probeZhipuTextConnectivity` | `components/settings-drawer/global-settings-panel.tsx` | 设置页手动测试 | 无 |

**每周复盘响应**：纯文本，须含固定小节标题：  
`【总览】【对齐用户写下的重点】【数据侧参考】【建议与修正提醒】【下周可做的一件事】【温和结语】`

---

### 2.8 目标墙（Vision Wall）

| 能力 | 智谱函数 | 调用位置 | 触发方式 | 结果存储 |
|---|---|---|---|---|
| **多目标可行性评估** | `analyzeVisionWallGoalsFromText` | `app/vision-wall.tsx` | 用户手动生成 | AsyncStorage `vision_wall_ai_assessment_v1` |

**响应**（`VisionWallAiAssessmentPayload`）：含 `feasibility_score`、`headline`、`sections[]`（4 节，每节 body ≥220 字）、`per_goal[]`、`closing_summary`（≥280 字）。

---

### 2.9 通用底层能力（供后端实现参考）

| 函数 | 用途 |
|---|---|
| `parseImageToJson` | 通用「图片 → JSON」视觉解析 |
| `zhipuVisionChatRaw` | 无固定 schema 的视觉对话 |
| `dispatchZhipuTextChat` / `dispatchZhipuVisionChat` | 内部 HTTP 封装（含重试） |

---

## 3. 后端需提供的接口（需求）

### 3.1 通用约定

- **Base URL**：与现有业务 API 相同，建议前缀 `/api/ai/...`
- **鉴权**：沿用 `POST /api/auth/login` 取得的 Bearer Token（与 `/api/data/*` 一致）
- **响应信封**（建议与现有一致）：

```json
{
  "code": 0,
  "message": "ok",
  "data": { }
}
```

- **错误**：`code !== 0` 时 `message` 为可读中文；HTTP 4xx/5xx 与现 `ApiRequestError` 行为一致
- **后端职责**：
  - 持有并轮换 `ZHIPU_API_KEY`（环境变量，勿硬编码进 App）
  - 实现智谱 `1305` 重试与请求串行/限流（可参考客户端 `runZhipuChatExclusive`）
  - 将 `lib/zhipu-image-parse.ts` 中各场景的 **system prompt、JSON schema、归一化逻辑** 迁移到服务端（可整文件移植为 Node 模块）
  - 图片类接口：接受 Base64 + MIME，或改为 multipart；**不要**要求客户端再传智谱 Key

### 3.2 建议接口列表

以下 **16 个业务接口 + 1 个探测接口** 与当前客户端能力一一对应。  
命名可按团队规范调整；重点是 **入参上下文由 App 组装**，与现 `build*SummaryText` 等函数输出一致。

#### 健康

| 方法 | 路径 | 请求体要点 | 响应 `data` |
|---|---|---|---|
| POST | `/api/ai/food/intake-from-text` | `{ text, question? }` | `FoodTextIntakeJson` |
| POST | `/api/ai/food/nutrition-from-image` | `{ image_base64, image_mime_type?, supplement_text? }` | `FoodNutritionJson` |
| POST | `/api/ai/food/daily-targets` | `{ context_block }` | `DailyIntakeTargetsEstimateJson` |

#### 财务

| 方法 | 路径 | 请求体要点 | 响应 `data` |
|---|---|---|---|
| POST | `/api/ai/finance/parse-one-liner` | `{ text, accounts?: [{ name, account_no? }] }` | 见 2.2 一句话记账 JSON |
| POST | `/api/ai/finance/parse-one-liner-from-image` | `{ image_base64, image_mime_type?, accounts? }` | 同上 + `is_bill` |
| POST | `/api/ai/finance/txn-comment` | `{ summary_text }` | `{ comment }` |
| POST | `/api/ai/finance/bill-summary-analysis` | `{ summary_text }` | `{ analysis }` |
| POST | `/api/ai/finance/dashboard-analysis` | `{ summary_text, past6_net_savings?, past6_income? }` | `AiFinanceDashboardPayload` |
| POST | `/api/ai/finance/cash-flow-analysis` | `{ summary_text }` | `{ analysis }` |

#### 心愿 / 备忘 / 项目 / 缺点

| 方法 | 路径 | 请求体要点 | 响应 `data` |
|---|---|---|---|
| POST | `/api/ai/wish-list/rational-review` | `{ context_text }` | `{ headline, review }` |
| POST | `/api/ai/wish-item/comment` | `{ summary_text }` | `{ comment }` |
| POST | `/api/ai/memo/review` | `{ memo_context_text }` | `{ evaluation, suggestions }` |
| POST | `/api/ai/project/tasks-review` | `{ project_context_text }` | `{ evaluation, suggestions }` |
| POST | `/api/ai/weakness/review` | `{ weakness_context_text }` | `{ evaluation, suggestions }` |

#### 复盘 / 目标墙

| 方法 | 路径 | 请求体要点 | 响应 `data` |
|---|---|---|---|
| POST | `/api/ai/weekly-review/coaching` | `{ user_prompt }` | `{ text }` 纯文本 |
| POST | `/api/ai/vision-wall/assessment` | `{ user_display_name?, plan_digest_text, expected_goal_ids[] }` | `VisionWallAiAssessmentPayload` |

#### 运维

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ai/health` | 后端用最小 prompt 调智谱，返回 `{ ok, model, latency_ms }`，替代客户端 `probeZhipuTextConnectivity` |

### 3.3 请求示例（迁移后 App 侧）

**迁移前（客户端，需删除）：**

```typescript
const r = await analyzeFinanceBillSummaryFromText({
  apiKey: getActiveAiLlmApiKey(),
  summaryText: billSummaryForAi,
});
```

**迁移后（建议）：**

```typescript
const r = await apiRequest<{ analysis: string }>('/api/ai/finance/bill-summary-analysis', {
  method: 'POST',
  body: { summary_text: billSummaryForAi },
});
```

### 3.4 客户端改造范围（供排期）

| 文件/目录 | 改造说明 |
|---|---|
| `lib/zhipu-image-parse.ts` | 逐步改为调用后端，或拆为 `lib/ai-api-client.ts` + 服务端保留 prompt |
| 所有 `getActiveAiLlmApiKey()` 调用点 | 移除密钥依赖，改调 `/api/ai/*` |
| `components/settings-drawer/global-settings-panel.tsx` | 智谱 Key 配置 UI 可改为「AI 服务状态」探测 `/api/ai/health` |
| `app/zhipu-api-test.tsx` | 改为后端联调页或删除 |
| 内置 `ZHIPU_EMBEDDED_API_KEY` | 迁移完成后从代码库删除 |

---

## 4. 附录：客户端文件索引

| 文件 | AI 相关职责 |
|---|---|
| `lib/zhipu-image-parse.ts` | 全部智谱 HTTP、Prompt、类型定义 |
| `lib/daily-intake-ai-targets.ts` | 首页摄入目标 + 缓存 |
| `lib/memo-ai-background.ts` | 备忘后台 AI |
| `lib/weakness-ai-background.ts` | 缺点后台 AI |
| `lib/project-ai-review-background.ts` | 项目 AI 点评 |
| `lib/weekly-review-coaching.ts` | 周复盘（AI + 本地兜底） |
| `lib/auto-ledger-runner.ts` | 截图自动记账 |
| `lib/repositories/finance/finance-txn-ai-comment.ts` | 流水 AI 短评 |
| `lib/repositories/wish-list/wish-item-ai-comment.ts` | 心愿 AI 短评 |
| `lib/repositories/wish-list/wish-list-rational-ai-cache.ts` | 心愿清单 AI 缓存 |
| `lib/vision-wall-ai-cache.ts` | 目标墙 AI 缓存 |
| `lib/api-config.ts` | 业务 REST 地址与登录凭据 |
| `lib/api-client.ts` | 业务 REST 客户端 |

---

## 5. 迁移优先级建议

1. **P0（密钥风险 + 高频）**：一句话记账、截图记账、流水 AI 短评、饮食识图/文字  
2. **P1（自动后台）**：备忘、缺点、心愿短评、首页摄入目标  
3. **P2（手动/低频）**：账单分析、AI 财务页、现金流分析、目标墙、周复盘、项目点评  

---

*本文档由客户端代码静态分析生成；Prompt 全文以 `lib/zhipu-image-parse.ts` 为准，后端实现时请直接移植该文件中的 system/user 模板与 JSON 校验逻辑，以保证 App 展示效果一致。*
