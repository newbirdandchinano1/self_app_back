import fs from 'fs';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const TABLE_LABELS = {
  account_transactions: '账户流水', accounts: '账户', admin_users: '管理员',
  app_meta: '应用元数据', app_settings: '应用设置', cash_flow_expense_lines: '现金流支出项',
  cash_flow_holdings: '现金流持仓', cash_flow_incomes: '现金流收入', cash_flow_profile: '现金流配置',
  daily_review_journal: '每日复盘', earned_rewards: '已获得奖励', finance_account_types: '财务账户类型',
  finance_accounts: '财务账户', finance_flow_categories: '财务流水分类', finance_transactions: '财务交易',
  frog_completion_events: '青蛙完成事件', goal_dimensions: '目标维度', habit_check_ins: '习惯打卡',
  habit_contexts: '习惯场景', habits: '习惯', health_records: '健康记录', memo_dimensions: '备忘录维度', memos: '备忘录',
  project_categories: '项目分类', projects: '项目',
  recipe_categories: '食谱分类', recipe_items: '食谱', review_columns: '复盘栏目', review_dimensions: '复盘维度',
  savings_plan_deposits: '储蓄存入记录', savings_plans: '储蓄计划', task_categories: '任务分类',
  task_execution_events: '任务执行事件', task_items: '任务子项', tasks: '任务',
  user_desired_skills: '期望技能', user_skill_items: '技能条目', user_skills_meta: '技能元数据',
  user_weaknesses: '待提升项', users: '用户', visions: '愿景', weekly_review_journal: '每周复盘', wish_items: '心愿单',
};

const COLUMN_LABELS = {
  id:'ID', key:'键名', slug:'标识', name:'名称', title:'标题', username:'账号', password:'密码',
  password_hash:'密码哈希', phone:'手机号', value:'值', value_json:'配置JSON', body:'内容', note:'备注', notes:'备注',
  description:'描述', detail:'详情', type:'类型', status:'状态', amount:'金额', balance:'余额', currency:'货币',
  category:'分类', dimension:'维度', category_id:'分类ID', category_label:'分类标签', account_id:'账户ID', account_no:'账号编号',
  account_type:'账户类型', parent_id:'父级ID', project_id:'项目ID', task_id:'任务ID', habit_id:'习惯ID',
  user_id:'用户ID', wish_item_id:'心愿ID', savings_plan_id:'储蓄计划ID', flow_category_id:'流水分类ID',
  dimension_id:'维度ID', linked_task_id:'关联任务ID', parent_task_id:'父任务ID', source_id:'来源ID',
  source_type:'来源类型', source_title:'来源标题', reward_kind:'奖励类型', label:'标签', tag:'标签', icon:'图标',
  icon_key:'图标键', tone:'色调', context:'场景', gender:'性别', lifestyle:'生活方式', goal:'目标',
  workout_days:'训练日', rest_days:'休息日', birthday:'生日', height:'身高', weight:'体重', age:'年龄',
  avatar_uri:'头像', reference_image_uri:'参考图片', finished_image_uri:'成品图片', source_image_uri:'来源图片',
  happened_at:'发生时间', earned_at:'获得时间', redeemed_at:'兑换时间', completed_at:'完成时间', due_date:'截止日期',
  record_date:'记录日期', record_date_ymd:'记录日期', week_start_ymd:'周起始日期', cache_date_ymd:'缓存日期',
  assigned_ymd:'分配日期', start_date:'开始日期', end_date:'结束日期', created_at:'创建时间', updated_at:'更新时间',
  sync_status:'同步状态', extra_data:'扩展数据', payload_json:'缓存数据',
  sort_order:'排序', is_done:'是否完成', is_builtin:'是否内置', is_liability:'是否负债', sign_rule:'符号规则',
  priority:'优先级', count:'次数', price:'价格', desire_level:'渴望程度', reason:'理由', bucket:'分类桶',
  quadrant:'象限', principal:'本金', inflow:'流入', outflow:'流出', necessary_expenses:'必要支出',
  unnecessary_expenses:'非必要支出', target_passive_income:'目标被动收入', target_months:'目标月数',
  seed_version:'种子版本', target_amount:'目标金额', transaction_type:'交易类型', ai_comment:'AI点评',
  ai_evaluation:'AI评价', ai_suggestions:'AI建议', ai_review_at:'AI评审时间', ai_coaching:'AI教练建议',
  last_evaluation:'最近评估', last_suggestions:'最近建议', last_ai_at:'最近AI时间',
  last_overall_suggestions:'最近综合建议', last_profile_analysis:'最近画像分析', target_level:'目标等级',
  action:'操作', task_title:'任务标题', placeholder:'占位提示', scope:'范围', track_kind:'轨道类型',
  direction:'方向', bg_option_idx:'背景选项', hydration:'饮水量', target_hydration:'目标饮水量', protein:'蛋白质',
  target_protein:'目标蛋白质', carbohydrate:'碳水化合物', target_carbohydrate:'目标碳水', calories:'摄入热量',
  target_calories:'目标热量', quick_add_key:'快捷添加键', intake_display_title:'摄入标题', intake_ai_comment:'摄入AI点评',
  ingredients_json:'食材JSON', steps_json:'步骤JSON', section_summary:'本周总结', section_plans:'本周计划',
  section_reflect:'本周反思', section_learnings:'本周收获', section_next_week:'下周安排', execution_score:'执行评分',
  adjust_tasks:'调整任务', adjust_savings:'调整储蓄', adjust_plans:'调整计划', inbox_entered_at:'进入收件箱时间',
};

const PK = { app_meta: 'key', app_settings: 'key' };
const HIDDEN = { admin_users: ['password_hash'] };

const MODULES = [
  { title: '用户与管理员', tables: ['users', 'admin_users'] },
  { title: '任务与项目', tables: ['task_categories', 'tasks', 'task_items', 'task_execution_events', 'project_categories', 'projects', 'frog_completion_events'] },
  { title: '习惯', tables: ['habits', 'habit_check_ins', 'habit_contexts'] },
  { title: '备忘录与愿景', tables: ['memo_dimensions', 'memos', 'visions', 'goal_dimensions', 'wish_items'] },
  { title: '健康与食谱', tables: ['health_records', 'recipe_categories', 'recipe_items'] },
  { title: '财务与账户', tables: ['accounts', 'account_transactions', 'finance_accounts', 'finance_account_types', 'finance_flow_categories', 'finance_transactions', 'cash_flow_profile', 'cash_flow_incomes', 'cash_flow_expense_lines', 'cash_flow_holdings', 'savings_plans', 'savings_plan_deposits'] },
  { title: '复盘与技能', tables: ['daily_review_journal', 'weekly_review_journal', 'review_dimensions', 'review_columns', 'user_skill_items', 'user_desired_skills', 'user_skills_meta', 'user_weaknesses', 'earned_rewards'] },
  { title: '系统与缓存', tables: ['app_meta', 'app_settings'] },
];

const tables = {};

async function loadSchema() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'self_app',
  });

  const [rows] = await conn.query(`
    SELECT TABLE_NAME AS tableName, COLUMN_NAME AS col, COLUMN_KEY AS \`key\`,
           IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, DATA_TYPE AS type
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);

  for (const row of rows) {
    const t = row.tableName;
    if (!tables[t]) tables[t] = [];
    tables[t].push({
      col: row.col,
      key: row.key || '',
      nullable: row.nullable,
      def: row.def == null ? 'NULL' : String(row.def),
      type: row.type,
    });
  }

  await conn.end();
}

function fieldNote(table, r) {
  const notes = [];
  if (r.key === 'PRI') notes.push('主键');
  else if (r.key === 'UNI') notes.push('唯一');
  else if (r.key === 'MUL') notes.push('索引');
  if (r.col === 'password_hash') notes.push('响应中不返回');
  if (table === 'admin_users' && r.col === 'password') notes.push('写入时用 password，服务端加密');
  if (table === 'memo_dimensions' && r.col === 'title') notes.push('App 端 name 写入本字段 title');
  if (table === 'memos' && r.col === 'dimension_id') notes.push('引用 memo_dimensions.id');
  if (table === 'memos' && r.col === 'dimension') notes.push('与 App 端 dimension 一致');
  return notes.length ? notes.join('；') : '-';
}

function mdTable(table, rows) {
  const header = '| 字段名 | 中文名 | 类型 | 必填 | 默认值 | 说明 |\n|--------|--------|------|------|--------|------|';
  const body = rows.map((r) =>
    `| \`${r.col}\` | ${COLUMN_LABELS[r.col] || r.col} | ${r.type} | ${r.nullable === 'NO' ? '是' : '否'} | ${r.def === 'NULL' ? '-' : r.def} | ${fieldNote(table, r)} |`,
  ).join('\n');
  return `${header}\n${body}`;
}

function generate() {
const tableNames = Object.keys(tables).sort();
let out = `# selfApp 数据库接口使用说明书

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

- **基础地址**：\`http://<服务器IP>:3000\`
- **数据格式**：\`application/json\`
- **字符编码**：UTF-8
- **时区**：服务端使用系统时区，时间字段为 ISO 8601 格式（如 \`2026-05-29T12:00:00.000Z\`）

### 接口设计原则

所有业务表共用同一套 URL 模式，将 \`:table\` 替换为英文表名即可：

\`\`\`
GET    /api/data/:table           查询列表
GET    /api/data/:table/:id       查询单条
POST   /api/data/:table           新增
PUT    /api/data/:table/:id       更新（部分字段）
PATCH  /api/data/:table/:id       更新（同 PUT）
DELETE /api/data/:table/:id       删除
\`\`\`

---

## 2. 通用约定

### 2.1 统一响应格式

**成功：**
\`\`\`json
{
  "code": 0,
  "message": "ok",
  "data": { }
}
\`\`\`

**失败：**
\`\`\`json
{
  "code": -1,
  "message": "错误描述",
  "data": null
}
\`\`\`

> **判断规则**：\`code === 0\` 表示成功，其余为失败。

### 2.2 认证方式

除 \`POST /api/auth/login\` 和 \`GET /health\` 外，所有 \`/api/*\` 接口均需在请求头携带 JWT：

\`\`\`
Authorization: Bearer <token>
\`\`\`

Token 有效期 **7 天**，过期后需重新登录。

### 2.3 自动填充字段

创建记录时，服务端会自动处理以下字段（若表中存在且请求未传）：

| 字段 | 行为 |
|------|------|
| \`id\` | 自动生成 UUID（varchar(36)） |
| \`created_at\` | 自动设为当前时间 |
| \`updated_at\` | 自动设为当前时间 |

更新记录时，\`updated_at\` 若未传则自动更新为当前时间。

### 2.4 删除行为

\`DELETE /api/data/:table/:id\` 为**物理删除**，记录从数据库中移除，不可恢复。

### 2.5 分页参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| \`page\` | number | 1 | 页码，从 1 开始 |
| \`limit\` | number | 50 | 每页条数，最大 200 |

### 2.6 列表响应结构

\`\`\`json
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
\`\`\`

---

## 3. 认证接口

### 3.1 登录

| 项目 | 值 |
|------|-----|
| **URL** | \`POST /api/auth/login\` |
| **认证** | 不需要 |
| **Content-Type** | \`application/json\` |

**请求体：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| \`username\` | string | 是 | 管理员账号 |
| \`password\` | string | 是 | 管理员密码（明文） |

**请求示例：**
\`\`\`json
{
  "username": "admin",
  "password": "zhen8907146"
}
\`\`\`

**成功响应（200）：**
\`\`\`json
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
\`\`\`

---

### 3.2 验证登录状态

| 项目 | 值 |
|------|-----|
| **URL** | \`GET /api/auth/me\` |
| **认证** | 需要 Bearer Token |

---

### 3.3 健康检查

| 项目 | 值 |
|------|-----|
| **URL** | \`GET /health\` |
| **认证** | 不需要 |

---

## 4. 通用数据接口

### 4.1 获取所有表元信息

| 项目 | 值 |
|------|-----|
| **URL** | \`GET /api/tables\` |
| **认证** | 需要 |

**说明**：返回所有可操作的表名、中文名、主键、字段列表（含中文标签）。建议 APP 启动时调用一次并缓存。

---

### 4.2 查询列表

| 项目 | 值 |
|------|-----|
| **URL** | \`GET /api/data/:table\` |
| **方法** | GET |
| **认证** | 需要 |

**查询参数：** 见 [2.5 分页参数](#25-分页参数)

**示例：** \`GET /api/data/tasks?page=1&limit=20\`

---

### 4.3 查询单条

| 项目 | 值 |
|------|-----|
| **URL** | \`GET /api/data/:table/:id\` |
| **方法** | GET |
| **认证** | 需要 |

---

### 4.4 新增记录

| 项目 | 值 |
|------|-----|
| **URL** | \`POST /api/data/:table\` |
| **方法** | POST |
| **认证** | 需要 |
| **Content-Type** | \`application/json\` |

---

### 4.5 更新记录

| 项目 | 值 |
|------|-----|
| **URL** | \`PUT /api/data/:table/:id\` 或 \`PATCH /api/data/:table/:id\` |
| **方法** | PUT / PATCH |
| **认证** | 需要 |

---

### 4.6 删除记录

| 项目 | 值 |
|------|-----|
| **URL** | \`DELETE /api/data/:table/:id\` |
| **方法** | DELETE |
| **认证** | 需要 |

---

## 5. 数据表详细说明

> 以下每张表均支持第 4 节中的全部 CRUD 操作。

### 表索引（43 张）

| 英文表名 | 中文名 | 主键 |
|---------|--------|------|
`;

for (const t of tableNames) {
  const pk = PK[t] || 'id';
  out += `| \`${t}\` | ${TABLE_LABELS[t] || t} | \`${pk}\` |\n`;
}

out += '\n---\n\n';

for (const mod of MODULES) {
  out += `### ${mod.title}\n\n`;
  for (const t of mod.tables) {
    const cols = tables[t];
    if (!cols) continue;
    const pk = PK[t] || 'id';
    const label = TABLE_LABELS[t] || t;
    const hidden = HIDDEN[t] || [];

    out += `#### ${label}（\`${t}\`）\n\n`;
    out += `| 属性 | 值 |\n|------|-----|\n`;
    out += `| 中文名 | ${label} |\n| 英文表名 | \`${t}\` |\n| 主键字段 | \`${pk}\` |\n\n`;

    out += `**接口地址：**\n\n| 操作 | 方法 | URL |\n|------|------|-----|\n`;
    out += `| 列表 | GET | \`/api/data/${t}\` |\n| 详情 | GET | \`/api/data/${t}/:${pk}\` |\n`;
    out += `| 新增 | POST | \`/api/data/${t}\` |\n| 更新 | PUT | \`/api/data/${t}/:${pk}\` |\n`;
    out += `| 删除 | DELETE | \`/api/data/${t}/:${pk}\` |\n\n`;

    if (t === 'admin_users') {
      out += `> 创建/更新时通过 \`password\` 字段传明文密码，服务端加密为 \`password_hash\`，查询不返回 \`password_hash\`。\n\n`;
    }
    if (pk !== 'id') {
      out += `> 创建时必须传入主键字段 \`${pk}\`。\n\n`;
    }

    const visibleCols = cols.filter((c) => !hidden.includes(c.col));
    out += `**字段说明：**\n\n${mdTable(t, visibleCols)}\n\n`;

    if (t === 'tasks') {
      out += `**新增请求示例：**\n\`\`\`json\n{"title":"完成周报","status":"todo","priority":1,"due_date":"2026-06-01"}\n\`\`\`\n\n`;
    }
    if (t === 'habits') {
      out += `**新增请求示例：**\n\`\`\`json\n{"name":"早起","context":"晨间","icon":"sun","sync_status":"pending_create"}\n\`\`\`\n\n`;
    }
    if (t === 'memos') {
      out += `**新增请求示例：**\n\`\`\`json\n{"title":"灵感","body":"记录内容"}\n\`\`\`\n\n`;
    }

    out += '---\n\n';
  }
}

out += `## 6. 错误码与状态码

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

1. 启动时 \`POST /api/auth/login\` 获取 Token 并持久化
2. 调用 \`GET /api/tables\` 缓存表结构与字段中文名
3. 按业务模块调用 \`GET /api/data/:table\` 同步数据
4. 本地变更通过 POST / PUT / DELETE 回写服务端
5. 收到 401 时引导重新登录

### 请求封装示例

\`\`\`javascript
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
\`\`\`

### 同步相关字段

多数业务表含 \`sync_status\`、\`created_at\`、\`updated_at\`，供本地与服务端同步使用。删除请调用 \`DELETE\` 接口做物理删除。

### 注意事项

- 请求 URL 中表名/字段名使用**英文**，界面展示使用 \`/api/tables\` 返回的 \`label\`
- 列表接口暂不支持按字段过滤（如 \`?user_id=xxx\`），需客户端过滤
- JSON 类型字段（\`extra_data\`、\`value_json\` 等）需传合法 JSON 字符串
- 生产环境请配置强随机 \`JWT_SECRET\`

---

## 附录：表名中英对照

| 英文表名 | 中文名 |
|---------|--------|
`;

for (const t of tableNames) {
  out += `| \`${t}\` | ${TABLE_LABELS[t] || t} |\n`;
}

out += '\n---\n\n*文档根据数据库 schema 生成，字段信息与线上一致。*\n';

fs.writeFileSync(new URL('../API.md', import.meta.url), out);
console.log('API.md generated, bytes:', out.length);
}

await loadSchema();
generate();
