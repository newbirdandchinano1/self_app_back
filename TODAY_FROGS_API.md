# 今日青蛙任务 API — APP 接入说明

> 版本：2026-06-25  
> 后端仓库：`self_app_back`  
> 对应前端：任务 Tab（`app/(tabs)/tasks.tsx`）、青蛙指派（`app/add-frog.tsx`）

---

## 1. 背景

任务 Tab 除「今日青蛙」外，仍需要**全量 tasks**（项目树、四象限、独立待办等）。因此推荐：

| 数据 | 拉取方式 |
|------|----------|
| 全量 tasks | `GET /api/pages/tasks` 或 `GET /api/data/tasks`（保持不变） |
| 今日青蛙子集 | **本接口** 或 List 参数过滤（见下文两种方式） |

后端按 `extra_data.frogAssignedOn` 精确匹配「逻辑今日」，减少客户端过滤开销。

---

## 2. 数据约定

青蛙状态写在 `tasks.extra_data` JSON 中，**字段名勿改**：

| JSON 键 | 类型 | 含义 |
|---------|------|------|
| `frogAssignedOn` | `string` | 指派为青蛙的逻辑日，`YYYY-MM-DD`；取消指派时**删除该键** |
| `frogSessionCompletedOn` | `string` | 长期任务「今日青蛙会话已结束」的逻辑日 |
| `isLongTermTask` | `boolean` | 是否长期任务（与筛选无关） |

### 逻辑日（日界）

与 bootstrap 一致，由 `dayBoundaryHour` / `dayBoundaryMinute` 决定：

```
若 当前本地时间 < 日界时刻 → 逻辑日 = 前一自然日
否则 → 逻辑日 = 当前自然日
```

**今日青蛙筛选条件**：`frogAssignedOn === logicalToday`（精确相等，非范围语义）。

---

## 3. 推荐接口：独立今日青蛙

### 3.1 请求

| 项目 | 值 |
|------|-----|
| **URL** | `GET /api/pages/tasks/today-frogs` |
| **认证** | `Authorization: Bearer <token>` |

**Query 参数：**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `dayBoundaryHour` | number | `0` | 日界小时（0–23） |
| `dayBoundaryMinute` | number | `0` | 日界分钟（0–59） |

**请求示例：**

```http
GET /api/pages/tasks/today-frogs?dayBoundaryHour=4&dayBoundaryMinute=0
Authorization: Bearer eyJhbG...
```

### 3.2 响应

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "logicalToday": "2026-06-25",
    "count": 3,
    "tasks": [
      {
        "id": "task-uuid",
        "title": "写周报",
        "status": "open",
        "priority": 80,
        "extra_data": "{\"frogAssignedOn\":\"2026-06-25\",\"isLongTermTask\":false}",
        "updated_at": "2026-06-25T08:30:00.000Z",
        "project_id": "proj-uuid",
        "parent_task_id": null
      }
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `logicalToday` | 服务端按日界计算的逻辑今日（`YYYY-MM-DD`） |
| `count` | 今日青蛙任务数量 |
| `tasks` | 任务完整行，与 `GET /api/data/tasks` 单条结构**完全一致**（含 `extra_data` 原样字符串） |

### 3.3 服务端排序

与 APP `tasks.tsx` 中 `todayFrogs` 一致：

1. **未完成**在前（见下方完成态规则）
2. `priority` 降序
3. `updated_at` 降序

### 3.4 完成态（仍由 APP 渲染）

后端**只筛指派日**，完成态 UI 仍由 APP 判断 `isFrogDoneForToday`：

```
IF status IN ('done', 'cancelled')           → 已完成
ELSE IF frogSessionCompletedOn == logicalToday → 已完成（长期任务今日会话结束）
ELSE                                         → 未完成
```

---

## 4. 备选：List API 参数过滤

若已封装 `fetchApiTableAll('tasks', params)`，可直接用通用 List 接口：

```http
GET /api/data/tasks?frogAssignedOnGte=2026-06-25&frogAssignedOnLte=2026-06-25&page=1&limit=50
Authorization: Bearer <token>
```

| 参数 | 说明 |
|------|------|
| `frogAssignedOnGte` | `extra_data.frogAssignedOn >= 值` |
| `frogAssignedOnLte` | `extra_data.frogAssignedOn <= 值` |
| `fields` | 可选，裁剪字段，如 `id,title,status,priority,extra_data,updated_at,project_id,parent_task_id` |

**精确匹配今日**：`frogAssignedOnGte` 与 `frogAssignedOnLte` 传**同一逻辑日**即可。

**响应结构**（与通用 List 一致）：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [ /* Task 行 */ ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 3,
      "totalPages": 1
    }
  }
}
```

> List 接口**不**自动计算 `logicalToday`，也不做完成态排序；需 APP 自行传入当日 YMD 并本地排序。

---

## 5. APP 接入建议

### 5.1 首屏（任务 Tab）

```
1. GET /api/pages/tasks          → 全量 tasks + 热力图等（不变）
2. GET /api/pages/tasks/today-frogs?dayBoundaryHour=…&dayBoundaryMinute=…
   → 今日青蛙列表，直接渲染卡片
```

全量 tasks 继续供项目树、四象限、独立待办使用。

### 5.2 增量刷新（指派 / 取消 / 完成青蛙后）

不必全表 refresh tasks，仅重拉今日青蛙：

```typescript
// 伪代码
async function refreshTodayFrogs() {
  const { logicalToday, tasks } = await fetchTodayFrogs(dayBoundary);
  // 写入本地缓存或内存 state
}
```

### 5.3 与 List 方式对比

| 方式 | 适用场景 |
|------|----------|
| `GET /api/pages/tasks/today-frogs` | 推荐；自动算 `logicalToday` + 排序，接入简单 |
| `GET /api/data/tasks?frogAssignedOnGte=L&frogAssignedOnLte=L` | 已有 List 封装、需分页或 fields 裁剪时 |

### 5.4 写操作（不变）

| 操作 | 接口 |
|------|------|
| 指派青蛙 | `PATCH /api/data/tasks/:id`，`extra_data` 合并写入 `frogAssignedOn: "YYYY-MM-DD"` |
| 取消指派 | `PATCH /api/data/tasks/:id`，从 `extra_data` **删除** `frogAssignedOn` 键 |
| 完成今日青蛙（长期任务） | 写入 `frogSessionCompletedOn: 当日 YMD`，不改 `status` |
| 完成整个任务 | `status` → `done` |

写操作后立即调用今日青蛙接口，结果会同步更新（无 stale 缓存）。

---

## 6. 边界说明

| 场景 | 是否出现在今日青蛙结果 |
|------|------------------------|
| `frogAssignedOn === logicalToday` | ✅ |
| `frogAssignedOn` 为昨日或其他日 | ❌ |
| 无 `frogAssignedOn` 键 | ❌ |
| `frogAssignedOn: ""` 或非法日期 | ❌ |
| 任务 `status === done` 但仍有 `frogAssignedOn` | ✅（仍返回，完成态由 APP 展示） |

> 今日青蛙列表读 `tasks.extra_data.frogAssignedOn`，**不是** `frog_completion_events` 表（热力图专用）。

---

## 7. 联调示例

**准备数据（示意）：**

| 任务 | extra_data.frogAssignedOn | 期望 |
|------|---------------------------|------|
| A | `2026-06-25` | ✅ 返回 |
| B | `2026-06-24` | ❌ |
| C | 无该键 | ❌ |

**日界示例：** `dayBoundaryHour=4` 时，服务器本地时间 `2026-06-25 03:30` 的 `logicalToday` 为 `2026-06-24`，应筛 `frogAssignedOn=2026-06-24` 的任务。

---

## 8. 错误处理

| HTTP | code | 说明 |
|------|------|------|
| 401 | -1 | Token 缺失或过期 |
| 500 | -1 | 服务端异常 |

成功时 `code === 0`。

---

## 9. 相关文件（后端）

| 模块 | 路径 |
|------|------|
| 今日青蛙服务 | `src/services/pages/today-frogs.ts` |
| List 过滤 | `src/services/list-query.ts` |
| 路由 | `src/routes/pages.ts` |
| 日界计算 | `src/services/calendar/logical-day.ts` |
