# self_app_back

SelfAPP 业务后端（Express + MySQL）：登录鉴权、业务 CRUD / 页面聚合、增量同步。  
场景 AI（智谱）已迁至 **selfAPP_AIAgent**；本服务仅在需要落库时代调 Agent（如备忘 AI 点评）。

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

## 目录要点

- `src/routes/app/` — App API
- `src/services/agent-ai-client.ts` — 代调 Agent 场景 AI
- `src/services/` — 业务服务
- `src/db/` — 建表 / 迁移辅助
