# selfApp 数据库接口使用说明书

> 版本：1.0.0  
> 更新日期：2026-05-29  
> 适用对象：移动端 APP / 客户端开发者

---

## 目录

1. [概述](#1-概述)
2. [通用约定](#2-通用约定)
3. [认证接口](#3-认证接口)
4. [通用数据接口](#4-通用数据接口)
5. [数据表详细说明](#5-数据表详细说明)
6. [错误码与状态码](#6-错误码与状态码)
7. [APP 集成建议](#7-app-集成建议)

---

## 1. 概述

本后端提供 **RESTful JSON API**，对数据库 **43 张表** 提供统一的增删改查（CRUD）能力。

- **基础地址**：`http://<服务器IP>:3000`
- **数据格式**：`application/json`
- **字符编码**：UTF-8
- **时区**：服务端使用系统时区，时间字段为 ISO 8601 格式（如 `2026-05-29T12:00:00.000Z`）

### 接口设计原则

所有业务表共用同一套 URL 模式，将 `:table` 替换为英文表名即可：

```
GET    /api/data/:table           查询列表
GET    /api/data/:table/:id       查询单条
POST   /api/data/:table           新增
PUT    /api/data/:table/:id       更新（部分字段）
PATCH  /api/data/:table/:id       更新（同 PUT）
DELETE /api/data/:table/:id       删除
```

---

## 2. 通用约定

### 2.1 统一响应格式

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
  "message": "错误描述",
  "data": null
}
```

> **判断规则**：`code === 0` 表示成功，其余为失败。

### 2.2 认证方式

除 `POST /api/auth/login` 和 `GET /health` 外，所有 `/api/*` 接口均需在请求头携带 JWT：

```
Authorization: Bearer <token>
```

Token 有效期 **7 天**，过期后需重新登录。

### 2.3 自动填充字段

创建记录时，服务端会自动处理以下字段（若表中存在且请求未传）：

| 字段 | 行为 |
|------|------|
| `id` | 自动生成 UUID（varchar(36)） |
| `created_at` | 自动设为当前时间 |
| `updated_at` | 自动设为当前时间 |

更新记录时，`updated_at` 若未传则自动更新为当前时间。

### 2.4 删除行为

`DELETE /api/data/:table/:id` 为**物理删除**，记录从数据库中移除，不可恢复。

### 2.5 分页参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | 1 | 页码，从 1 开始 |
| `limit` | number | 50 | 每页条数，最大 200 |

### 2.6 列表响应结构

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [ { "...": "..." } ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 128,
      "totalPages": 3
    }
  }
}
```

---

## 3. 认证接口

### 3.1 登录

| 项目 | 值 |
|------|-----|
| **URL** | `POST /api/auth/login` |
| **认证** | 不需要 |
| **Content-Type** | `application/json` |

**请求体：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `username` | string | 是 | 管理员账号 |
| `password` | string | 是 | 管理员密码（明文） |

**请求示例：**
```json
{
  "username": "admin",
  "password": "zhen8907146"
}
```

**成功响应（200）：**
```json
{
  "code": 0,
  "message": "登录成功",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "admin": {
      "id": "54b1fc78-dbe1-480c-b389-24aef34c3e44",
      "username": "admin",
      "phone": "18081654196"
    }
  }
}
```

---

### 3.2 验证登录状态

| 项目 | 值 |
|------|-----|
| **URL** | `GET /api/auth/me` |
| **认证** | 需要 Bearer Token |

---

### 3.3 健康检查

| 项目 | 值 |
|------|-----|
| **URL** | `GET /health` |
| **认证** | 不需要 |

---

## 4. 通用数据接口

### 4.1 获取所有表元信息

| 项目 | 值 |
|------|-----|
| **URL** | `GET /api/tables` |
| **认证** | 需要 |

**说明**：返回所有可操作的表名、中文名、主键、字段列表（含中文标签）。建议 APP 启动时调用一次并缓存。

---

### 4.2 查询列表

| 项目 | 值 |
|------|-----|
| **URL** | `GET /api/data/:table` |
| **方法** | GET |
| **认证** | 需要 |

**查询参数：** 见 [2.5 分页参数](#25-分页参数)

**示例：** `GET /api/data/tasks?page=1&limit=20`

---

### 4.3 查询单条

| 项目 | 值 |
|------|-----|
| **URL** | `GET /api/data/:table/:id` |
| **方法** | GET |
| **认证** | 需要 |

---

### 4.4 新增记录

| 项目 | 值 |
|------|-----|
| **URL** | `POST /api/data/:table` |
| **方法** | POST |
| **认证** | 需要 |
| **Content-Type** | `application/json` |

---

### 4.5 更新记录

| 项目 | 值 |
|------|-----|
| **URL** | `PUT /api/data/:table/:id` 或 `PATCH /api/data/:table/:id` |
| **方法** | PUT / PATCH |
| **认证** | 需要 |

---

### 4.6 删除记录

| 项目 | 值 |
|------|-----|
| **URL** | `DELETE /api/data/:table/:id` |
| **方法** | DELETE |
| **认证** | 需要 |

---

## 5. 数据表详细说明

> 以下每张表均支持第 4 节中的全部 CRUD 操作。

### 表索引（43 张）

| 英文表名 | 中文名 | 主键 |
|---------|--------|------|
| `account_transactions` | 账户流水 | `id` |
| `accounts` | 账户 | `id` |
| `admin_users` | 管理员 | `id` |
| `app_meta` | 应用元数据 | `key` |
| `app_settings` | 应用设置 | `key` |
| `cash_flow_expense_lines` | 现金流支出项 | `id` |
| `cash_flow_holdings` | 现金流持仓 | `id` |
| `cash_flow_incomes` | 现金流收入 | `id` |
| `cash_flow_profile` | 现金流配置 | `id` |
| `daily_review_journal` | 每日复盘 | `id` |
| `earned_rewards` | 已获得奖励 | `id` |
| `finance_account_types` | 财务账户类型 | `id` |
| `finance_accounts` | 财务账户 | `id` |
| `finance_flow_categories` | 财务流水分类 | `id` |
| `finance_transactions` | 财务交易 | `id` |
| `frog_completion_events` | 青蛙完成事件 | `id` |
| `goal_dimensions` | 目标维度 | `id` |
| `habit_check_ins` | 习惯打卡 | `id` |
| `habit_contexts` | 习惯场景 | `id` |
| `habits` | 习惯 | `id` |
| `health_records` | 健康记录 | `id` |
| `memo_dimensions` | 备忘录维度 | `id` |
| `memos` | 备忘录 | `id` |
| `project_categories` | 项目分类 | `id` |
| `projects` | 项目 | `id` |
| `recipe_categories` | 食谱分类 | `id` |
| `recipe_items` | 食谱 | `id` |
| `review_columns` | 复盘栏目 | `id` |
| `review_dimensions` | 复盘维度 | `id` |
| `savings_plan_deposits` | 储蓄存入记录 | `id` |
| `savings_plans` | 储蓄计划 | `id` |
| `task_categories` | 任务分类 | `id` |
| `task_execution_events` | 任务执行事件 | `id` |
| `task_items` | 任务子项 | `id` |
| `tasks` | 任务 | `id` |
| `user_desired_skills` | 期望技能 | `id` |
| `user_skill_items` | 技能条目 | `id` |
| `user_skills_meta` | 技能元数据 | `id` |
| `user_weaknesses` | 待提升项 | `id` |
| `users` | 用户 | `id` |
| `visions` | 愿景 | `id` |
| `weekly_review_journal` | 每周复盘 | `id` |
| `wish_items` | 心愿单 | `id` |

---

### 用户与管理员

#### 用户（`users`）

| 属性 | 值 |
|------|-----|
| 中文名 | 用户 |
| 英文表名 | `users` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/users` |
| 详情 | GET | `/api/data/users/:id` |
| 新增 | POST | `/api/data/users` |
| 更新 | PUT | `/api/data/users/:id` |
| 删除 | DELETE | `/api/data/users/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | 默认用户 | - |
| `avatar_uri` | 头像 | text | 否 | - | - |
| `gender` | 性别 | varchar | 是 | 男 | - |
| `lifestyle` | 生活方式 | varchar | 是 | 长期静坐不运动 | - |
| `goal` | 目标 | varchar | 是 | 无 | - |
| `workout_days` | 训练日 | varchar | 否 | - | - |
| `rest_days` | 休息日 | varchar | 否 | - | - |
| `birthday` | 生日 | varchar | 否 | - | - |
| `height` | 身高 | double | 是 | 0 | - |
| `weight` | 体重 | double | 是 | 0 | - |
| `age` | 年龄 | int | 是 | 0 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |

---

#### 管理员（`admin_users`）

| 属性 | 值 |
|------|-----|
| 中文名 | 管理员 |
| 英文表名 | `admin_users` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/admin_users` |
| 详情 | GET | `/api/data/admin_users/:id` |
| 新增 | POST | `/api/data/admin_users` |
| 更新 | PUT | `/api/data/admin_users/:id` |
| 删除 | DELETE | `/api/data/admin_users/:id` |

> 创建/更新时通过 `password` 字段传明文密码，服务端加密为 `password_hash`，查询不返回 `password_hash`。

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `username` | 账号 | varchar | 是 | - | 唯一 |
| `phone` | 手机号 | varchar | 是 | - | 唯一 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |

---

### 任务与项目

#### 任务分类（`task_categories`）

| 属性 | 值 |
|------|-----|
| 中文名 | 任务分类 |
| 英文表名 | `task_categories` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/task_categories` |
| 详情 | GET | `/api/data/task_categories/:id` |
| 新增 | POST | `/api/data/task_categories` |
| 更新 | PUT | `/api/data/task_categories/:id` |
| 删除 | DELETE | `/api/data/task_categories/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `sort_order` | 排序 | int | 是 | 1000 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 任务（`tasks`）

| 属性 | 值 |
|------|-----|
| 中文名 | 任务 |
| 英文表名 | `tasks` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/tasks` |
| 详情 | GET | `/api/data/tasks/:id` |
| 新增 | POST | `/api/data/tasks` |
| 更新 | PUT | `/api/data/tasks/:id` |
| 删除 | DELETE | `/api/data/tasks/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `project_id` | 项目ID | varchar | 否 | - | 索引 |
| `category_id` | 分类ID | varchar | 否 | - | 索引 |
| `parent_task_id` | 父任务ID | varchar | 否 | - | 索引 |
| `title` | 标题 | varchar | 是 | - | - |
| `description` | 描述 | text | 否 | - | - |
| `note` | 备注 | text | 否 | - | - |
| `status` | 状态 | varchar | 是 | todo | 索引 |
| `priority` | 优先级 | int | 是 | 0 | - |
| `due_date` | 截止日期 | varchar | 否 | - | 索引 |
| `completed_at` | 完成时间 | datetime | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |
| `sort_order` | 排序 | int | 否 | - | - |

**新增请求示例：**
```json
{"title":"完成周报","status":"todo","priority":1,"due_date":"2026-06-01"}
```

---

#### 任务子项（`task_items`）

| 属性 | 值 |
|------|-----|
| 中文名 | 任务子项 |
| 英文表名 | `task_items` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/task_items` |
| 详情 | GET | `/api/data/task_items/:id` |
| 新增 | POST | `/api/data/task_items` |
| 更新 | PUT | `/api/data/task_items/:id` |
| 删除 | DELETE | `/api/data/task_items/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `task_id` | 任务ID | varchar | 是 | - | 索引 |
| `title` | 标题 | varchar | 是 | - | - |
| `is_done` | 是否完成 | tinyint | 是 | 0 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |

---

#### 任务执行事件（`task_execution_events`）

| 属性 | 值 |
|------|-----|
| 中文名 | 任务执行事件 |
| 英文表名 | `task_execution_events` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/task_execution_events` |
| 详情 | GET | `/api/data/task_execution_events/:id` |
| 新增 | POST | `/api/data/task_execution_events` |
| 更新 | PUT | `/api/data/task_execution_events/:id` |
| 删除 | DELETE | `/api/data/task_execution_events/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `task_id` | 任务ID | varchar | 否 | - | 索引 |
| `action` | 操作 | varchar | 是 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | 索引 |
| `task_title` | 任务标题 | varchar | 否 | - | - |

---

#### 项目分类（`project_categories`）

| 属性 | 值 |
|------|-----|
| 中文名 | 项目分类 |
| 英文表名 | `project_categories` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/project_categories` |
| 详情 | GET | `/api/data/project_categories/:id` |
| 新增 | POST | `/api/data/project_categories` |
| 更新 | PUT | `/api/data/project_categories/:id` |
| 删除 | DELETE | `/api/data/project_categories/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `sort_order` | 排序 | int | 是 | 1000 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 项目（`projects`）

| 属性 | 值 |
|------|-----|
| 中文名 | 项目 |
| 英文表名 | `projects` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/projects` |
| 详情 | GET | `/api/data/projects/:id` |
| 新增 | POST | `/api/data/projects` |
| 更新 | PUT | `/api/data/projects/:id` |
| 删除 | DELETE | `/api/data/projects/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `category_id` | 分类ID | varchar | 否 | - | 索引 |
| `name` | 名称 | varchar | 是 | - | - |
| `status` | 状态 | varchar | 是 | active | 索引 |
| `note` | 备注 | text | 否 | - | - |
| `due_date` | 截止日期 | varchar | 否 | - | 索引 |
| `inbox_entered_at` | 进入收件箱时间 | datetime | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 青蛙完成事件（`frog_completion_events`）

| 属性 | 值 |
|------|-----|
| 中文名 | 青蛙完成事件 |
| 英文表名 | `frog_completion_events` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/frog_completion_events` |
| 详情 | GET | `/api/data/frog_completion_events/:id` |
| 新增 | POST | `/api/data/frog_completion_events` |
| 更新 | PUT | `/api/data/frog_completion_events/:id` |
| 删除 | DELETE | `/api/data/frog_completion_events/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `task_id` | 任务ID | varchar | 否 | - | 索引 |
| `assigned_ymd` | 分配日期 | varchar | 是 | - | 索引 |
| `action` | 操作 | varchar | 是 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `task_title` | 任务标题 | varchar | 否 | - | - |

---

### 习惯

#### 习惯（`habits`）

| 属性 | 值 |
|------|-----|
| 中文名 | 习惯 |
| 英文表名 | `habits` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/habits` |
| 详情 | GET | `/api/data/habits/:id` |
| 新增 | POST | `/api/data/habits` |
| 更新 | PUT | `/api/data/habits/:id` |
| 删除 | DELETE | `/api/data/habits/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `context` | 场景 | varchar | 是 | - | 索引 |
| `name` | 名称 | varchar | 是 | - | - |
| `tag` | 标签 | varchar | 否 | - | - |
| `icon` | 图标 | varchar | 是 | - | - |
| `tone` | 色调 | varchar | 否 | - | - |
| `note` | 备注 | text | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

**新增请求示例：**
```json
{"name":"早起","context":"晨间","icon":"sun","sync_status":"pending_create"}
```

---

#### 习惯打卡（`habit_check_ins`）

| 属性 | 值 |
|------|-----|
| 中文名 | 习惯打卡 |
| 英文表名 | `habit_check_ins` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/habit_check_ins` |
| 详情 | GET | `/api/data/habit_check_ins/:id` |
| 新增 | POST | `/api/data/habit_check_ins` |
| 更新 | PUT | `/api/data/habit_check_ins/:id` |
| 删除 | DELETE | `/api/data/habit_check_ins/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `habit_id` | 习惯ID | varchar | 是 | - | 索引 |
| `record_date` | 记录日期 | varchar | 是 | - | 索引 |
| `count` | 次数 | int | 是 | 1 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |

---

#### 习惯场景（`habit_contexts`）

| 属性 | 值 |
|------|-----|
| 中文名 | 习惯场景 |
| 英文表名 | `habit_contexts` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/habit_contexts` |
| 详情 | GET | `/api/data/habit_contexts/:id` |
| 新增 | POST | `/api/data/habit_contexts` |
| 更新 | PUT | `/api/data/habit_contexts/:id` |
| 删除 | DELETE | `/api/data/habit_contexts/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `sort_order` | 排序 | int | 是 | 1000 | - |
| `is_builtin` | 是否内置 | tinyint | 是 | 0 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

### 备忘录与愿景

#### 备忘录维度（`memo_dimensions`）

| 属性 | 值 |
|------|-----|
| 中文名 | 备忘录维度 |
| 英文表名 | `memo_dimensions` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/memo_dimensions` |
| 详情 | GET | `/api/data/memo_dimensions/:id` |
| 新增 | POST | `/api/data/memo_dimensions` |
| 更新 | PUT | `/api/data/memo_dimensions/:id` |
| 删除 | DELETE | `/api/data/memo_dimensions/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `title` | 标题 | varchar | 是 |  | - |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 备忘录（`memos`）

| 属性 | 值 |
|------|-----|
| 中文名 | 备忘录 |
| 英文表名 | `memos` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/memos` |
| 详情 | GET | `/api/data/memos/:id` |
| 新增 | POST | `/api/data/memos` |
| 更新 | PUT | `/api/data/memos/:id` |
| 删除 | DELETE | `/api/data/memos/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `title` | 标题 | varchar | 是 |  | - |
| `body` | 内容 | text | 是 | - | - |
| `ai_evaluation` | AI评价 | text | 否 | - | - |
| `ai_suggestions` | AI建议 | text | 否 | - | - |
| `ai_review_at` | AI评审时间 | datetime | 否 | - | - |
| `linked_task_id` | 关联任务ID | varchar | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | synced | - |

**新增请求示例：**
```json
{"title":"灵感","body":"记录内容"}
```

---

#### 愿景（`visions`）

| 属性 | 值 |
|------|-----|
| 中文名 | 愿景 |
| 英文表名 | `visions` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/visions` |
| 详情 | GET | `/api/data/visions/:id` |
| 新增 | POST | `/api/data/visions` |
| 更新 | PUT | `/api/data/visions/:id` |
| 删除 | DELETE | `/api/data/visions/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `title` | 标题 | varchar | 是 | - | - |
| `description` | 描述 | text | 否 | - | - |
| `track_kind` | 轨道类型 | varchar | 是 | - | - |
| `direction` | 方向 | varchar | 否 | - | - |
| `bg_option_idx` | 背景选项 | int | 是 | 0 | - |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 目标维度（`goal_dimensions`）

| 属性 | 值 |
|------|-----|
| 中文名 | 目标维度 |
| 英文表名 | `goal_dimensions` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/goal_dimensions` |
| 详情 | GET | `/api/data/goal_dimensions/:id` |
| 新增 | POST | `/api/data/goal_dimensions` |
| 更新 | PUT | `/api/data/goal_dimensions/:id` |
| 删除 | DELETE | `/api/data/goal_dimensions/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `title` | 标题 | varchar | 是 | - | - |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 心愿单（`wish_items`）

| 属性 | 值 |
|------|-----|
| 中文名 | 心愿单 |
| 英文表名 | `wish_items` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/wish_items` |
| 详情 | GET | `/api/data/wish_items/:id` |
| 新增 | POST | `/api/data/wish_items` |
| 更新 | PUT | `/api/data/wish_items/:id` |
| 删除 | DELETE | `/api/data/wish_items/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `price` | 价格 | double | 是 | - | - |
| `category_id` | 分类ID | varchar | 否 | - | 索引 |
| `category_label` | 分类标签 | varchar | 否 | - | - |
| `desire_level` | 渴望程度 | int | 是 | 3 | - |
| `reason` | 理由 | text | 否 | - | - |
| `reference_image_uri` | 参考图片 | text | 否 | - | - |
| `ai_comment` | AI点评 | text | 否 | - | - |
| `ai_review_at` | AI评审时间 | datetime | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

### 健康与食谱

#### 健康记录（`health_records`）

| 属性 | 值 |
|------|-----|
| 中文名 | 健康记录 |
| 英文表名 | `health_records` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/health_records` |
| 详情 | GET | `/api/data/health_records/:id` |
| 新增 | POST | `/api/data/health_records` |
| 更新 | PUT | `/api/data/health_records/:id` |
| 删除 | DELETE | `/api/data/health_records/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `user_id` | 用户ID | varchar | 是 | - | 索引 |
| `hydration` | 饮水量 | double | 是 | 0 | - |
| `target_hydration` | 目标饮水量 | double | 是 | 0 | - |
| `protein` | 蛋白质 | double | 是 | 0 | - |
| `target_protein` | 目标蛋白质 | double | 是 | 0 | - |
| `carbohydrate` | 碳水化合物 | double | 是 | 0 | - |
| `target_carbohydrate` | 目标碳水 | double | 是 | 0 | - |
| `sodium` | 钠 | double | 是 | 0 | - |
| `target_sodium` | 目标钠 | double | 是 | 0 | - |
| `record_date` | 记录日期 | varchar | 是 | - | 索引 |
| `quick_add_key` | 快捷添加键 | varchar | 否 | - | - |
| `source_image_uri` | 来源图片 | text | 否 | - | - |
| `intake_display_title` | 摄入标题 | varchar | 否 | - | - |
| `intake_ai_comment` | 摄入AI点评 | text | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |

---

#### 食谱分类（`recipe_categories`）

| 属性 | 值 |
|------|-----|
| 中文名 | 食谱分类 |
| 英文表名 | `recipe_categories` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/recipe_categories` |
| 详情 | GET | `/api/data/recipe_categories/:id` |
| 新增 | POST | `/api/data/recipe_categories` |
| 更新 | PUT | `/api/data/recipe_categories/:id` |
| 删除 | DELETE | `/api/data/recipe_categories/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | synced | - |

---

#### 食谱（`recipe_items`）

| 属性 | 值 |
|------|-----|
| 中文名 | 食谱 |
| 英文表名 | `recipe_items` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/recipe_items` |
| 详情 | GET | `/api/data/recipe_items/:id` |
| 新增 | POST | `/api/data/recipe_items` |
| 更新 | PUT | `/api/data/recipe_items/:id` |
| 删除 | DELETE | `/api/data/recipe_items/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `category_id` | 分类ID | varchar | 是 | - | 索引 |
| `title` | 标题 | varchar | 是 |  | - |
| `ingredients_json` | 食材JSON | text | 是 | - | - |
| `steps_json` | 步骤JSON | text | 是 | - | - |
| `notes` | 备注 | text | 否 | - | - |
| `finished_image_uri` | 成品图片 | text | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | synced | - |

---

### 财务与账户

#### 账户（`accounts`）

| 属性 | 值 |
|------|-----|
| 中文名 | 账户 |
| 英文表名 | `accounts` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/accounts` |
| 详情 | GET | `/api/data/accounts/:id` |
| 新增 | POST | `/api/data/accounts` |
| 更新 | PUT | `/api/data/accounts/:id` |
| 删除 | DELETE | `/api/data/accounts/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `type` | 类型 | varchar | 是 | - | - |
| `balance` | 余额 | double | 是 | 0 | - |
| `currency` | 货币 | varchar | 是 | CNY | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |

---

#### 账户流水（`account_transactions`）

| 属性 | 值 |
|------|-----|
| 中文名 | 账户流水 |
| 英文表名 | `account_transactions` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/account_transactions` |
| 详情 | GET | `/api/data/account_transactions/:id` |
| 新增 | POST | `/api/data/account_transactions` |
| 更新 | PUT | `/api/data/account_transactions/:id` |
| 删除 | DELETE | `/api/data/account_transactions/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `account_id` | 账户ID | varchar | 是 | - | 索引 |
| `amount` | 金额 | double | 是 | - | - |
| `category` | 分类 | varchar | 否 | - | - |
| `note` | 备注 | text | 否 | - | - |
| `happened_at` | 发生时间 | datetime | 是 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |

---

#### 财务账户（`finance_accounts`）

| 属性 | 值 |
|------|-----|
| 中文名 | 财务账户 |
| 英文表名 | `finance_accounts` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/finance_accounts` |
| 详情 | GET | `/api/data/finance_accounts/:id` |
| 新增 | POST | `/api/data/finance_accounts` |
| 更新 | PUT | `/api/data/finance_accounts/:id` |
| 删除 | DELETE | `/api/data/finance_accounts/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `account_no` | 账号编号 | varchar | 否 | - | - |
| `account_type` | 账户类型 | varchar | 是 | asset | - |
| `sign_rule` | 符号规则 | tinyint | 是 | 1 | - |
| `note` | 备注 | text | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 财务账户类型（`finance_account_types`）

| 属性 | 值 |
|------|-----|
| 中文名 | 财务账户类型 |
| 英文表名 | `finance_account_types` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/finance_account_types` |
| 详情 | GET | `/api/data/finance_account_types/:id` |
| 新增 | POST | `/api/data/finance_account_types` |
| 更新 | PUT | `/api/data/finance_account_types/:id` |
| 删除 | DELETE | `/api/data/finance_account_types/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `is_liability` | 是否负债 | tinyint | 是 | 0 | - |
| `icon_key` | 图标键 | varchar | 是 | savings | - |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 财务流水分类（`finance_flow_categories`）

| 属性 | 值 |
|------|-----|
| 中文名 | 财务流水分类 |
| 英文表名 | `finance_flow_categories` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/finance_flow_categories` |
| 详情 | GET | `/api/data/finance_flow_categories/:id` |
| 新增 | POST | `/api/data/finance_flow_categories` |
| 更新 | PUT | `/api/data/finance_flow_categories/:id` |
| 删除 | DELETE | `/api/data/finance_flow_categories/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `parent_id` | 父级ID | varchar | 否 | - | 索引 |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `is_builtin` | 是否内置 | tinyint | 是 | 0 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 财务交易（`finance_transactions`）

| 属性 | 值 |
|------|-----|
| 中文名 | 财务交易 |
| 英文表名 | `finance_transactions` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/finance_transactions` |
| 详情 | GET | `/api/data/finance_transactions/:id` |
| 新增 | POST | `/api/data/finance_transactions` |
| 更新 | PUT | `/api/data/finance_transactions/:id` |
| 删除 | DELETE | `/api/data/finance_transactions/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `happened_at` | 发生时间 | datetime | 是 | - | 索引 |
| `account_id` | 账户ID | varchar | 是 | - | 索引 |
| `ai_comment` | AI点评 | text | 否 | - | - |
| `transaction_type` | 交易类型 | varchar | 是 | expense | - |
| `flow_category_id` | 流水分类ID | varchar | 否 | - | 索引 |
| `amount` | 金额 | double | 是 | - | - |
| `note` | 备注 | text | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 现金流配置（`cash_flow_profile`）

| 属性 | 值 |
|------|-----|
| 中文名 | 现金流配置 |
| 英文表名 | `cash_flow_profile` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/cash_flow_profile` |
| 详情 | GET | `/api/data/cash_flow_profile/:id` |
| 新增 | POST | `/api/data/cash_flow_profile` |
| 更新 | PUT | `/api/data/cash_flow_profile/:id` |
| 删除 | DELETE | `/api/data/cash_flow_profile/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `necessary_expenses` | 必要支出 | double | 是 | 0 | - |
| `unnecessary_expenses` | 非必要支出 | double | 是 | 0 | - |
| `target_passive_income` | 目标被动收入 | double | 是 | 0 | - |
| `target_months` | 目标月数 | int | 是 | 12 | - |
| `seed_version` | 种子版本 | int | 是 | 0 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 现金流收入（`cash_flow_incomes`）

| 属性 | 值 |
|------|-----|
| 中文名 | 现金流收入 |
| 英文表名 | `cash_flow_incomes` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/cash_flow_incomes` |
| 详情 | GET | `/api/data/cash_flow_incomes/:id` |
| 新增 | POST | `/api/data/cash_flow_incomes` |
| 更新 | PUT | `/api/data/cash_flow_incomes/:id` |
| 删除 | DELETE | `/api/data/cash_flow_incomes/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `amount` | 金额 | double | 是 | - | - |
| `quadrant` | 象限 | varchar | 是 | - | - |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 现金流支出项（`cash_flow_expense_lines`）

| 属性 | 值 |
|------|-----|
| 中文名 | 现金流支出项 |
| 英文表名 | `cash_flow_expense_lines` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/cash_flow_expense_lines` |
| 详情 | GET | `/api/data/cash_flow_expense_lines/:id` |
| 新增 | POST | `/api/data/cash_flow_expense_lines` |
| 更新 | PUT | `/api/data/cash_flow_expense_lines/:id` |
| 删除 | DELETE | `/api/data/cash_flow_expense_lines/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `amount` | 金额 | double | 是 | - | - |
| `bucket` | 分类桶 | varchar | 是 | - | - |
| `sort_order` | 排序 | int | 是 | 1000 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 现金流持仓（`cash_flow_holdings`）

| 属性 | 值 |
|------|-----|
| 中文名 | 现金流持仓 |
| 英文表名 | `cash_flow_holdings` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/cash_flow_holdings` |
| 详情 | GET | `/api/data/cash_flow_holdings/:id` |
| 新增 | POST | `/api/data/cash_flow_holdings` |
| 更新 | PUT | `/api/data/cash_flow_holdings/:id` |
| 删除 | DELETE | `/api/data/cash_flow_holdings/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `principal` | 本金 | double | 是 | 0 | - |
| `inflow` | 流入 | double | 是 | 0 | - |
| `outflow` | 流出 | double | 是 | 0 | - |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 储蓄计划（`savings_plans`）

| 属性 | 值 |
|------|-----|
| 中文名 | 储蓄计划 |
| 英文表名 | `savings_plans` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/savings_plans` |
| 详情 | GET | `/api/data/savings_plans/:id` |
| 新增 | POST | `/api/data/savings_plans` |
| 更新 | PUT | `/api/data/savings_plans/:id` |
| 删除 | DELETE | `/api/data/savings_plans/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 | - | - |
| `start_date` | 开始日期 | varchar | 是 | - | - |
| `end_date` | 结束日期 | varchar | 是 | - | - |
| `target_amount` | 目标金额 | double | 是 | - | - |
| `avatar_uri` | 头像 | text | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 储蓄存入记录（`savings_plan_deposits`）

| 属性 | 值 |
|------|-----|
| 中文名 | 储蓄存入记录 |
| 英文表名 | `savings_plan_deposits` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/savings_plan_deposits` |
| 详情 | GET | `/api/data/savings_plan_deposits/:id` |
| 新增 | POST | `/api/data/savings_plan_deposits` |
| 更新 | PUT | `/api/data/savings_plan_deposits/:id` |
| 删除 | DELETE | `/api/data/savings_plan_deposits/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `savings_plan_id` | 储蓄计划ID | varchar | 是 | - | 索引 |
| `amount` | 金额 | double | 是 | - | - |
| `note` | 备注 | text | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

### 复盘与技能

#### 每日复盘（`daily_review_journal`）

| 属性 | 值 |
|------|-----|
| 中文名 | 每日复盘 |
| 英文表名 | `daily_review_journal` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/daily_review_journal` |
| 详情 | GET | `/api/data/daily_review_journal/:id` |
| 新增 | POST | `/api/data/daily_review_journal` |
| 更新 | PUT | `/api/data/daily_review_journal/:id` |
| 删除 | DELETE | `/api/data/daily_review_journal/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `record_date_ymd` | 记录日期 | varchar | 是 | - | 唯一 |
| `body` | 内容 | text | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 每周复盘（`weekly_review_journal`）

| 属性 | 值 |
|------|-----|
| 中文名 | 每周复盘 |
| 英文表名 | `weekly_review_journal` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/weekly_review_journal` |
| 详情 | GET | `/api/data/weekly_review_journal/:id` |
| 新增 | POST | `/api/data/weekly_review_journal` |
| 更新 | PUT | `/api/data/weekly_review_journal/:id` |
| 删除 | DELETE | `/api/data/weekly_review_journal/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `week_start_ymd` | 周起始日期 | varchar | 是 | - | 唯一 |
| `section_summary` | 本周总结 | text | 否 | - | - |
| `section_plans` | 本周计划 | text | 否 | - | - |
| `section_reflect` | 本周反思 | text | 否 | - | - |
| `section_learnings` | 本周收获 | text | 否 | - | - |
| `section_next_week` | 下周安排 | text | 否 | - | - |
| `execution_score` | 执行评分 | int | 是 | 0 | - |
| `ai_coaching` | AI教练建议 | text | 否 | - | - |
| `adjust_tasks` | 调整任务 | tinyint | 是 | 0 | - |
| `adjust_savings` | 调整储蓄 | tinyint | 是 | 0 | - |
| `adjust_plans` | 调整计划 | tinyint | 是 | 0 | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 复盘维度（`review_dimensions`）

| 属性 | 值 |
|------|-----|
| 中文名 | 复盘维度 |
| 英文表名 | `review_dimensions` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/review_dimensions` |
| 详情 | GET | `/api/data/review_dimensions/:id` |
| 新增 | POST | `/api/data/review_dimensions` |
| 更新 | PUT | `/api/data/review_dimensions/:id` |
| 删除 | DELETE | `/api/data/review_dimensions/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `scope` | 范围 | varchar | 是 | - | 索引 |
| `title` | 标题 | varchar | 是 | - | - |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 复盘栏目（`review_columns`）

| 属性 | 值 |
|------|-----|
| 中文名 | 复盘栏目 |
| 英文表名 | `review_columns` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/review_columns` |
| 详情 | GET | `/api/data/review_columns/:id` |
| 新增 | POST | `/api/data/review_columns` |
| 更新 | PUT | `/api/data/review_columns/:id` |
| 删除 | DELETE | `/api/data/review_columns/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `dimension_id` | 维度ID | varchar | 是 | - | 索引 |
| `title` | 标题 | varchar | 是 | - | - |
| `placeholder` | 占位提示 | varchar | 否 | - | - |
| `sort_order` | 排序 | int | 是 | 1000 | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

#### 技能条目（`user_skill_items`）

| 属性 | 值 |
|------|-----|
| 中文名 | 技能条目 |
| 英文表名 | `user_skill_items` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/user_skill_items` |
| 详情 | GET | `/api/data/user_skill_items/:id` |
| 新增 | POST | `/api/data/user_skill_items` |
| 更新 | PUT | `/api/data/user_skill_items/:id` |
| 删除 | DELETE | `/api/data/user_skill_items/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 |  | - |
| `description` | 描述 | text | 是 | - | - |
| `last_evaluation` | 最近评估 | text | 否 | - | - |
| `last_suggestions` | 最近建议 | text | 否 | - | - |
| `sort_order` | 排序 | int | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | synced | - |

---

#### 期望技能（`user_desired_skills`）

| 属性 | 值 |
|------|-----|
| 中文名 | 期望技能 |
| 英文表名 | `user_desired_skills` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/user_desired_skills` |
| 详情 | GET | `/api/data/user_desired_skills/:id` |
| 新增 | POST | `/api/data/user_desired_skills` |
| 更新 | PUT | `/api/data/user_desired_skills/:id` |
| 删除 | DELETE | `/api/data/user_desired_skills/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `name` | 名称 | varchar | 是 |  | - |
| `target_level` | 目标等级 | varchar | 是 |  | - |
| `sort_order` | 排序 | int | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | synced | - |

---

#### 技能元数据（`user_skills_meta`）

| 属性 | 值 |
|------|-----|
| 中文名 | 技能元数据 |
| 英文表名 | `user_skills_meta` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/user_skills_meta` |
| 详情 | GET | `/api/data/user_skills_meta/:id` |
| 新增 | POST | `/api/data/user_skills_meta` |
| 更新 | PUT | `/api/data/user_skills_meta/:id` |
| 删除 | DELETE | `/api/data/user_skills_meta/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `last_ai_at` | 最近AI时间 | datetime | 否 | - | - |
| `last_overall_suggestions` | 最近综合建议 | text | 否 | - | - |
| `last_profile_analysis` | 最近画像分析 | text | 否 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |

---

#### 待提升项（`user_weaknesses`）

| 属性 | 值 |
|------|-----|
| 中文名 | 待提升项 |
| 英文表名 | `user_weaknesses` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/user_weaknesses` |
| 详情 | GET | `/api/data/user_weaknesses/:id` |
| 新增 | POST | `/api/data/user_weaknesses` |
| 更新 | PUT | `/api/data/user_weaknesses/:id` |
| 删除 | DELETE | `/api/data/user_weaknesses/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `title` | 标题 | varchar | 是 |  | - |
| `detail` | 详情 | text | 是 | - | - |
| `ai_evaluation` | AI评价 | text | 否 | - | - |
| `ai_suggestions` | AI建议 | text | 否 | - | - |
| `ai_review_at` | AI评审时间 | datetime | 否 | - | - |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |
| `sync_status` | 同步状态 | varchar | 是 | synced | - |

---

#### 已获得奖励（`earned_rewards`）

| 属性 | 值 |
|------|-----|
| 中文名 | 已获得奖励 |
| 英文表名 | `earned_rewards` |
| 主键字段 | `id` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/earned_rewards` |
| 详情 | GET | `/api/data/earned_rewards/:id` |
| 新增 | POST | `/api/data/earned_rewards` |
| 更新 | PUT | `/api/data/earned_rewards/:id` |
| 删除 | DELETE | `/api/data/earned_rewards/:id` |

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `id` | ID | varchar | 是 | - | 主键 |
| `source_type` | 来源类型 | varchar | 是 | - | 索引 |
| `source_id` | 来源ID | varchar | 是 | - | - |
| `source_title` | 来源标题 | varchar | 是 | - | - |
| `reward_kind` | 奖励类型 | varchar | 是 | - | - |
| `wish_item_id` | 心愿ID | varchar | 否 | - | 索引 |
| `label` | 标签 | varchar | 是 | - | - |
| `earned_at` | 获得时间 | datetime | 是 | - | 索引 |
| `redeemed_at` | 兑换时间 | datetime | 否 | - | 索引 |
| `created_at` | 创建时间 | datetime | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | 索引 |
| `sync_status` | 同步状态 | varchar | 是 | pending_create | - |
| `extra_data` | 扩展数据 | text | 否 | - | - |

---

### 系统与缓存

#### 应用元数据（`app_meta`）

| 属性 | 值 |
|------|-----|
| 中文名 | 应用元数据 |
| 英文表名 | `app_meta` |
| 主键字段 | `key` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/app_meta` |
| 详情 | GET | `/api/data/app_meta/:key` |
| 新增 | POST | `/api/data/app_meta` |
| 更新 | PUT | `/api/data/app_meta/:key` |
| 删除 | DELETE | `/api/data/app_meta/:key` |

> 创建时必须传入主键字段 `key`。

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `key` | 键名 | varchar | 是 | - | 主键 |
| `value` | 值 | text | 是 | - | - |

---

#### 应用设置（`app_settings`）

| 属性 | 值 |
|------|-----|
| 中文名 | 应用设置 |
| 英文表名 | `app_settings` |
| 主键字段 | `key` |

**接口地址：**

| 操作 | 方法 | URL |
|------|------|-----|
| 列表 | GET | `/api/data/app_settings` |
| 详情 | GET | `/api/data/app_settings/:key` |
| 新增 | POST | `/api/data/app_settings` |
| 更新 | PUT | `/api/data/app_settings/:key` |
| 删除 | DELETE | `/api/data/app_settings/:key` |

> 创建时必须传入主键字段 `key`。

**字段说明：**

| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |
|--------|--------|------|------|--------|------|
| `key` | 键名 | varchar | 是 | - | 主键 |
| `value_json` | 配置JSON | text | 是 | - | - |
| `updated_at` | 更新时间 | datetime | 是 | - | - |

---

## 6. 错误码与状态码

| HTTP 状态码 | 说明 |
|------------|------|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | 未登录或 Token 过期 |
| 404 | 表或记录不存在 |
| 409 | 唯一字段冲突 |
| 500 | 服务器错误 |

| 业务 code | 说明 |
|----------|------|
| 0 | 成功 |
| -1 | 失败（见 message） |

---

## 7. APP 集成建议

1. 启动时 `POST /api/auth/login` 获取 Token 并持久化
2. 调用 `GET /api/tables` 缓存表结构与字段中文名
3. 按业务模块调用 `GET /api/data/:table` 同步数据
4. 本地变更通过 POST / PUT / DELETE 回写服务端
5. 收到 401 时引导重新登录

### 请求封装示例

```javascript
const BASE_URL = 'http://your-server:3000';
let token = localStorage.getItem('token');

async function request(path, options = {}) {
  const res = await fetch(BASE_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...options.headers,
    },
  });
  const data = await res.json();
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (data.code !== 0) throw new Error(data.message);
  return data.data;
}
```

### 同步相关字段

多数业务表含 `sync_status`、`created_at`、`updated_at`，供本地与服务端同步使用。删除请调用 `DELETE` 接口做物理删除。

### 注意事项

- 请求 URL 中表名/字段名使用**英文**，界面展示使用 `/api/tables` 返回的 `label`
- 列表接口暂不支持按字段过滤（如 `?user_id=xxx`），需客户端过滤
- JSON 类型字段（`extra_data`、`value_json` 等）需传合法 JSON 字符串
- 生产环境请配置强随机 `JWT_SECRET`

---

## 附录：表名中英对照

| 英文表名 | 中文名 |
|---------|--------|
| `account_transactions` | 账户流水 |
| `accounts` | 账户 |
| `admin_users` | 管理员 |
| `app_meta` | 应用元数据 |
| `app_settings` | 应用设置 |
| `cash_flow_expense_lines` | 现金流支出项 |
| `cash_flow_holdings` | 现金流持仓 |
| `cash_flow_incomes` | 现金流收入 |
| `cash_flow_profile` | 现金流配置 |
| `daily_review_journal` | 每日复盘 |
| `earned_rewards` | 已获得奖励 |
| `finance_account_types` | 财务账户类型 |
| `finance_accounts` | 财务账户 |
| `finance_flow_categories` | 财务流水分类 |
| `finance_transactions` | 财务交易 |
| `frog_completion_events` | 青蛙完成事件 |
| `goal_dimensions` | 目标维度 |
| `habit_check_ins` | 习惯打卡 |
| `habit_contexts` | 习惯场景 |
| `habits` | 习惯 |
| `health_records` | 健康记录 |
| `memo_dimensions` | 备忘录维度 |
| `memos` | 备忘录 |
| `project_categories` | 项目分类 |
| `projects` | 项目 |
| `recipe_categories` | 食谱分类 |
| `recipe_items` | 食谱 |
| `review_columns` | 复盘栏目 |
| `review_dimensions` | 复盘维度 |
| `savings_plan_deposits` | 储蓄存入记录 |
| `savings_plans` | 储蓄计划 |
| `task_categories` | 任务分类 |
| `task_execution_events` | 任务执行事件 |
| `task_items` | 任务子项 |
| `tasks` | 任务 |
| `user_desired_skills` | 期望技能 |
| `user_skill_items` | 技能条目 |
| `user_skills_meta` | 技能元数据 |
| `user_weaknesses` | 待提升项 |
| `users` | 用户 |
| `visions` | 愿景 |
| `weekly_review_journal` | 每周复盘 |
| `wish_items` | 心愿单 |

---

*文档根据数据库 schema 生成，字段信息与线上一致。*
