# 阶段 E：灰度 Checklist

## 开关（保留可回滚）

| 开关 | 建议灰度值 | 回滚 |
|------|------------|------|
| `TASKS_BOOTSTRAP_V2_ENABLED` | `false`（验证后再 `true`） | 保持 `false` |
| `EXPO_PUBLIC_TASKS_MODULE_LOADING_ENABLED`（mobile） | 默认开；回滚设 `0`/`false` | `false` → 旧单一 pending |
| `TASKS_DANGEROUS_BOOTSTRAP_REJECT` | `true` | `false`（只告警不拒绝） |
| `PAGE_CONCURRENCY_LIMIT_ENABLED` | `true` | `false`（退回单池 `API_CONCURRENCY_MAX`） |
| `API_CONCURRENCY_MAX` | `12` | 临时上调（勿直接 50） |
| `DB_QUEUE_LIMIT` / `DB_ACQUIRE_TIMEOUT_MS` | `50` / `3000` | 仅应急调大；禁止 `queueLimit=0` |

## 同灰度硬约束（A2 + 前端 D3）

必须**同时**生效，禁止「只限流后端、前端仍 90s timeout」：

- 后端：`API_CONCURRENCY_MAX=12` + 有限 `DB_QUEUE_LIMIT` + 503/`Retry-After`
- 前端 timeout：core/projects 5s、habits 3s、heatmap 8s、后台同步 20s
- 前端首屏并发 ≤ 3；429/503 短退避；abort 不 toast

对照实验：`PHASE_E_BACKEND_ONLY_LIMIT=1` 跑 `phase-e-loadtest` / 前端 gate **必须失败**（拒绝上线）。

## 发布阶梯

1. 开发环境：跑通 `npm run test:phase-e` + 优先自测
2. 内部账号：任务页打开、有缓存冷热启动、故意断网/503
3. 10% → 50% → 全量（按身份或网关比例）

## Desktop 共用后端

桌面端 `selfAPP_destop` 已使用同套 page API timeout（catalog/habits/heatmap 5s/3s/8s）。灰度时必须抽测：

- [ ] Desktop 任务页打开（standaloneTodos + projects）
- [ ] Desktop 无无 `taskView` 危险大 bootstrap
- [ ] 503 时客户端可恢复、不刷业务失败

## 验收证明

1. 超时下降，不是单纯变 503（看 P95 与 503 占比）
2. 连接池等待下降（`db_acquire_wait_ms`）
3. 有本地缓存时快速可交互（模块 loading）
4. 局部失败不阻塞整页
5. heatmap 净完成 / 青蛙互斥口径不回归（`test:phase-b` / `test:tasks-page`）

## 命令

```bash
# 后端门禁 + 模拟压测 + 优先业务自测
cd self_app_back && npm run test:phase-e

# 前端门禁
cd selfApp && npm run test:phase-e

# 对照实验（应 exit 2）
PHASE_E_BACKEND_ONLY_LIMIT=1 npm run test:phase-e-loadtest
```
