# self_app_back

SelfAPP 业务后端（Express + MySQL）：登录鉴权、业务 CRUD / 页面聚合、增量同步。  
场景 AI（智谱）已迁至 **selfAPP_AIAgent**；本服务仅在需要落库时代调 Agent（如备忘 AI 点评）。

任务 `status` 枚举（`TASK_STATUS_OPTIONS`）：`todo` / `doing` / `blocked` / `done` / `cancelled` / `shelved`，与 App 编辑页状态芯片一致。

## 开发

```bash
npm install
npm run dev
```

环境变量见项目根目录 `.env` / `.env.example`。与 Agent 联调：

| 变量 | 说明 |
|------|------|
| `AGENT_BASE_URL` | Agent 根地址，默认 `http://localhost:8000` |
| `AGENT_API_KEY` | 与 Agent `API_KEY` 一致，请求头 `X-API-Key` |
| `AGENT_TIMEOUT_MS` | 代调超时，默认 `120000` |

## AI 相关（本服务）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/app/memos/:id/ai-review` | 代调 Agent 点评备忘并写库 |

其余场景（饮食 / 财务 / 周复盘 / 纯备忘点评等）由 App **直连** Agent：`/api/v1/ai/*`。  
App 对接说明见：`../selfApp/AI_API.md`；Agent 说明见：`../selfAPP_AIAgent/README.md`。

## 衣橱

表由 `ensure-wardrobe.ts`（migration `019` / `020`）创建；写入走专用接口，禁止 `/api/data` 通用写。  
图片复用 `/api/app/images`；UI 偏好可用 `app_settings`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/app/wardrobe/bootstrap` | 首屏聚合 |
| GET/POST/PATCH/DELETE | `/api/app/wardrobe/closets[/:id]` | 衣橱空间 |
| GET/POST/PATCH/DELETE | `/api/app/wardrobe/categories[/:id]` | 分类；另有 `/with-items` |
| GET/POST/PUT\|PATCH/DELETE | `/api/app/wardrobe/items[/:id]` | 单品；另有 `/count` |
| GET/POST/PATCH/DELETE | `/api/app/wardrobe/occasions[/:id]` | 场合 |
| GET/POST/PUT\|PATCH/DELETE | `/api/app/wardrobe/outfits[/:id]` | 搭配（`item_ids`） |
| POST | `/api/app/wardrobe/wear/item` | 穿单品（幂等按日） |
| POST | `/api/app/wardrobe/wear/outfit` | 穿搭配（展开单品日志） |
| DELETE | `/api/app/wardrobe/wear/logs/:id` | 撤销穿着 |
| GET | `/api/app/wardrobe/wear/week` | 周历 / 连续天数（App 衣橱首页周条 + 本周穿搭卡） |
| GET | `/api/app/wardrobe/wear/item/:id/history` | 近 28 天点阵 |
| GET/POST/PATCH/DELETE | `/api/app/wardrobe/options[/:id]` | 颜色/品牌/季节/版型词条 |
| GET/PUT | `/api/app/wardrobe/body-profile` | 身材与默认尺码 |
| GET | `/api/app/wardrobe/stats/summary` | 分类/季节/色系/高穿着统计 |

同步：9 张 `wardrobe_*` 已进白名单 / Change Log / 禁通用写。

## 目录要点

- `src/routes/app/` — App API（含 `wardrobe.ts`）
- `src/services/agent-ai-client.ts` — 代调 Agent 场景 AI
- `src/services/` — 业务服务（衣橱：`wardrobe.ts`）
- `src/db/` — 建表 / 迁移辅助（衣橱 9 表：`ensure-wardrobe.ts` / `019_wardrobe` + `020_wardrobe_option_body`）
