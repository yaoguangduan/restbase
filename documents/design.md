# RestBase — 需求与设计文档

> **版本**: 1.0 &nbsp;|&nbsp; **运行时**: Bun &nbsp;|&nbsp; **框架**: Hono &nbsp;|&nbsp; **校验**: Zod

---

## 一、项目概述

RestBase 是一个**零代码通用 REST 服务**：连接 SQLite 或 MySQL 数据库后，自动将所有数据表通过 REST API 暴露，内置用户管理与租户隔离能力，可直接被前端应用使用，无需额外后端开发。

---

## 二、技术规格

### 2.1 技术栈

| 组件       | 用途                      | 备注                                                      |
|----------|-------------------------|---------------------------------------------------------|
| **Bun**  | 运行时 + DB 驱动 (`Bun.SQL`) | 不兼容 Node.js API，优先使用 `Bun.env`、`Bun.file`、`Bun.serve` 等 |
| **Hono** | HTTP 框架                 | 内置 JWT 中间件、requestId 中间件、Zod 集成                         |
| **Zod**  | 请求体校验                   | 通过 `@hono/zod-validator` 集成                             |
| **pino** | 日志                      | 控制台纯文本输出、`pino-roll`（文件滚动）                              |

### 2.2 开发规范

- 使用 `.env` 作为配置文件（Bun 原生支持），遵循**约定大于配置**原则，所有配置项均有默认值
- 根目录仅保留必要的 `.ts` 文件（`server.ts`、`db.ts`、`types.ts`、`auth.ts`、`crud.ts`、`query.ts`、`logger.ts`）
- 代码量控制在 1000–2000 行，高可读性、必要注释、规范格式

---

## 三、环境变量配置

| 变量                        | 说明                                           | 默认值                 |
|:--------------------------|:---------------------------------------------|:--------------------|
| `SVR_NAME`                | 实例名称（`status` 中显示）                           | 空                   |
| `SVR_PORT`                | 服务监听端口                                       | `3333`              |
| `SVR_STATIC`              | 静态文件目录（相对路径，如 `public`），支持 SPA fallback      | 空（不启用）              |
| `SVR_API_LIMIT`           | API 限流：每秒每个接口允许的最大请求数（0 = 不限流）               | `100`               |
| `SVR_CORS_ORIGIN`        | CORS 允许的来源（逗号分隔多个，`*` = 全部）                  | `*`                 |
| `DB_URL`                  | 数据库连接串（`sqlite://` 或 `mysql://`）             | `sqlite://:memory:` |
| `DB_AUTH_TABLE`           | 用户认证表名                                       | `users`             |
| `DB_AUTH_FIELD`           | 数据表中的 owner 字段名                              | `owner`             |
| `DB_AUTH_FIELD_NULL_OPEN` | owner 为 NULL 视为公开数据（查询追加 `OR owner IS NULL`） | `false`             |
| `DB_INIT_SQL`             | 启动时执行的 SQL 文件路径（相对于项目根目录）                    | 空（不执行）              |
| `AUTH_JWT_SECRET`         | JWT 签名密钥                                     | `restbase`          |
| `AUTH_JWT_EXP`            | JWT 过期时间（秒）                                  | `43200`（12 小时）      |
| `AUTH_BASIC_OPEN`         | 是否开启 Basic Auth                              | `true`              |
| `LOG_LEVEL`               | 日志等级：`ERROR` / `INFO` / `DEBUG`              | `INFO`              |
| `LOG_CONSOLE`             | 是否输出到控制台                                     | `true`              |
| `LOG_FILE`                | 日志文件路径（如 `log/app.log`）                      | 空（不写文件）             |
| `LOG_RETAIN_DAYS`         | 日志文件保留天数                                     | `7`                 |

---

## 四、横向功能

### 4.1 数据库连接与初始化

1. **启动时连接数据库**，失败则 `process.exit(1)` 终止
2. **自动创建用户表**（`ensureAuthTable`）：确保 `DB_AUTH_TABLE` 指定的表存在且含 `id`、`username`（UNIQUE）、`password` 三个必需字段
3. **执行初始化 SQL**（`loadInitSql`）：若配置了 `DB_INIT_SQL`，读取文件并执行所有 SQL 语句
    - 支持 `--` 单行注释，语句以 `;` 分隔
    - 文件不存在则输出警告日志并跳过
4. **表结构分析**（`introspect`）：遍历所有表，获取列名、类型、主键、是否有 owner 字段
5. **校验用户表**（`validateAuth`）：确认用户表包含 `id`、`username`、`password`

### 4.2 租户隔离

- 数据表含 `DB_AUTH_FIELD`（默认 `owner`）字段 → 所有增删改查自动追加 `WHERE owner = 当前用户ID`
- 创建记录时自动注入 `owner` 值
- 不含 `owner` 字段的表 → 全局可见，所有已认证用户可访问
- **`DB_AUTH_FIELD_NULL_OPEN=true`** 时，owner 为 NULL 的记录视为公开数据，查询条件变为 `WHERE (owner = 当前用户ID OR owner IS NULL)`。适用于"
  部分记录公开、部分私有"的场景（如公共模板 + 用户自定义模板）

### 4.3 鉴权

同时支持两种认证方式，在 Hono 中间件中统一处理：

| 方式             | Header 格式                                | 说明                                                |
|:---------------|:-----------------------------------------|:--------------------------------------------------|
| **JWT**        | `Authorization: Bearer <token>`          | 登录/注册后返回 token，payload 含 `{ sub, uid, iat, exp }` |
| **Basic Auth** | `Authorization: Basic base64(user:pass)` | 每次请求验证用户名密码，可通过 `AUTH_BASIC_OPEN=false` 关闭        |

**公开路径**（无需鉴权）：

- `POST /api/auth/login`
- `POST /api/auth/register`
- `GET /api/health`

### 4.4 统一响应格式

所有接口统一返回 **HTTP 200** + JSON（包括业务错误），杜绝 4xx/5xx：

```json
{
  "code": "OK",
  "message": "错误时的详细信息（成功时可省略）",
  "data": "任意 JSON 结构",
  "pageNo": 1,
  "pageSize": 20,
  "total": 100
}
```

**错误码一览：**

| code               | 触发场景                           |
|:-------------------|:-------------------------------|
| `OK`               | 成功                             |
| `AUTH_ERROR`       | 未登录 / 密码错误 / Token 过期 / 用户已存在  |
| `VALIDATION_ERROR` | Zod 请求体校验失败                    |
| `NOT_FOUND`        | 表不存在                           |
| `CONFLICT`         | 记录已存在（主键冲突）                    |
| `TABLE_ERROR`      | 表无主键（不支持按 ID 操作）               |
| `FORBIDDEN`        | 禁止直接操作用户认证表（需使用 `/api/auth/*`） |
| `QUERY_ERROR`      | 查询语法错误（无效字段、操作符等）              |
| `RATE_LIMITED`     | API 请求频率超限                     |
| `SYS_ERROR`        | 未预期的系统异常                       |

### 4.5 日志系统

基于 **pino** 实现结构化日志：

- **控制台**：纯文本格式，含时间戳、级别、请求 ID
- **文件**：`pino-roll` NDJSON 格式，level/time 可读化
    - **按天滚动**：每天零点将当前文件重命名为 `{文件名}.{YYYY-MM-DD}`
    - **按大小滚动**：单文件超过 20MB 时滚动，同一天内多次滚动按序号递增（如 `app.log.2025-02-10.1`、`app.log.2025-02-10.2`）
    - 当前活跃文件始终为配置的原始路径（如 `app.log`）
    - 超过 `LOG_RETAIN_DAYS` 的归档文件自动清理

**日志级别行为：**

| 级别         | 输出内容                                      |
|:-----------|:------------------------------------------|
| `ERROR`    | 仅错误                                       |
| `INFO`（默认） | 每个请求：requestId / method / path / 耗时(ms)   |
| `DEBUG`    | 在 INFO 基础上追加：完整 headers、请求体、响应体、SQL 语句及参数 |

**请求 ID**：通过 Hono `requestId` 中间件自动生成 UUID，也允许客户端通过 `X-Request-Id` 请求头携带自定义 ID。所有日志行包含该 ID 以便全链路追踪。

### 4.6 CORS 跨域

通过 `SVR_CORS_ORIGIN` 环境变量配置允许的来源（默认 `*`），适配前后端分离部署：

- `SVR_CORS_ORIGIN=*` — 允许所有来源（默认）
- `SVR_CORS_ORIGIN=https://example.com` — 仅允许指定来源
- `SVR_CORS_ORIGIN=https://a.com,https://b.com` — 逗号分隔多个来源
- 允许方法：`GET` / `POST` / `PUT` / `DELETE` / `OPTIONS`
- 允许请求头：`Content-Type` / `Authorization` / `X-Request-Id`
- 暴露响应头：`X-Request-Id`
- Preflight 缓存：24 小时

### 4.7 API 限流

基于**令牌桶算法**，按 `METHOD + PATH` 维度对每个 API 接口独立限流：

- 每个接口每秒最多允许 `SVR_API_LIMIT` 次请求（默认 100，适配 4 核 8G 节点）
- 超限时返回 `{ "code": "RATE_LIMITED", "message": "Rate limit exceeded (100 req/s)" }`，响应头附带 `Retry-After: 1`
- 设置 `SVR_API_LIMIT=0` 可关闭限流
- 仅对 `/api/*` 路径生效，静态文件不受限流影响

> 限流粒度为接口级别（如 `GET /api/data/products` 和 `POST /api/data/products` 独立计数），而非 IP 级别。

### 4.8 JSON 响应格式化

所有 JSON 响应默认 **pretty print**（`JSON.stringify(body, null, 2)`），方便调试和阅读。

---

## 五、接口定义

### 5.1 健康检查

| 方法    | 路径            | 鉴权 | 说明                                               |
|:------|:--------------|:---|:-------------------------------------------------|
| `GET` | `/api/health` | 否  | 返回实例状态、name/port/pid/cwd/logFile/uptime/memory/cpu 等运行时元信息 |

---

### 5.2 元数据接口

> 所有元数据接口需鉴权。前端可据此动态生成表单和表格。

#### GET /api/meta/tables

获取所有数据表（不含用户表）的元数据。

```json
// 响应
{
  "code": "OK",
  "data": [
    {
      "name": "products",
      "pk": "id",
      "hasOwner": true,
      "columns": [
        { "name": "id", "type": "integer", "isNumeric": true },
        { "name": "name", "type": "text", "isNumeric": false },
        { "name": "price", "type": "real", "isNumeric": true }
      ]
    }
  ]
}
```

#### GET /api/meta/tables/:name

获取指定表的元数据，结构与列表中的单个元素一致。表不存在或为用户表时 `data` 返回 `null`。

#### GET /api/meta/sync

运行时重新扫描数据库，刷新内存中的表元数据缓存。适用于运行期间新建了表或修改了表结构的场景。返回同步后的全部表元数据（格式同 `GET /api/meta/tables`）。无需请求参数。

---

### 5.3 鉴权接口

#### POST /api/auth/login — 登录

```json
// 请求（Zod：username ≥ 1 字符，password ≥ 1 字符）
{ "username": "admin", "password": "admin" }

// 成功响应
{ "code": "OK", "data": "eyJhbGciOiJIUzI1NiIs..." }

// 失败响应
{ "code": "AUTH_ERROR", "message": "Invalid username or password" }
```

#### POST /api/auth/register — 注册

请求体、校验规则与登录一致。成功返回 JWT token，用户已存在返回 `AUTH_ERROR`。

#### GET /api/auth/profile — 获取用户资料

返回当前用户的完整记录（**去掉 `id` 和 `password`**）：

```json
{ "code": "OK", "data": { "username": "alice", "age": 26, "email": "..." } }
```

#### POST /api/auth/profile — 更新用户资料

传入要更新的字段 KV，仅更新**表中实际存在的列**（`id` 不可修改），不存在的 key 忽略。支持更新 `password`。

```json
// 请求
{ "age": 27, "email": "new@example.com" }

// 响应
{ "code": "OK", "data": null }
```

---

### 5.4 前端查询/删除接口（POST JSON Body）

> 前端推荐使用以下接口，通过 JSON Body 传递复杂查询条件，避免 URL 参数拼接。配套 TypeScript 客户端见 `client/` 目录。

#### POST /api/query/:table — 复杂查询

```json
// 请求体
{
  "select": ["name", "price:unitPrice", "count:id:total",
             {"field": "price", "func": "max", "alias": "maxPrice"}],
  "where": [
    ["price", "gt", 100],
    ["name", "like", "%test%"],
    {"field": "stock", "op": "ge", "value": 50},
    {"op": "or", "cond": [
      ["category", "Electronics"],
      {"field": "is_active", "op": "eq", "value": 1}
    ]}
  ],
  "order": ["name", "desc.price", {"field": "stock", "dir": "desc"}],
  "group": ["category"],
  "pageNo": 1,
  "pageSize": 20
}
```

**where 格式**（灵活，以下写法均可，`cond` 内递归支持所有格式）：

| 写法    | 示例                                       | 说明              |
|:------|:-----------------------------------------|:----------------|
| 二元组   | `["name", "test"]`                       | 默认 `eq`         |
| 三元组   | `["price", "gt", 100]`                   | 指定操作符           |
| 对象    | `{"field":"stock","op":"ge","value":50}` | 显式格式            |
| 逻辑组   | `{"op":"or","cond":[...]}`               | `and` / `or` 嵌套 |
| 单条件简写 | `"where": ["id","eq",1]`                 | where 本身为一个元组   |

**操作符一览：**

| 操作符              | SQL                   | 说明                            |
|:-----------------|:----------------------|:------------------------------|
| `eq`             | `=`                   | 等于                            |
| `ne`             | `!=`                  | 不等于                           |
| `gt` / `ge`      | `>` / `>=`            | 大于 / 大于等于                     |
| `lt` / `le`      | `<` / `<=`            | 小于 / 小于等于                     |
| `is`             | `IS NULL`             | 为空（`value` 固定为 `null`）        |
| `nis`            | `IS NOT NULL`         | 不为空                           |
| `like` / `nlike` | `LIKE` / `NOT LIKE`   | 模糊匹配（直接使用 SQL `%` 通配符）        |
| `in` / `nin`     | `IN (...)` / `NOT IN` | 在/不在列表中（`value` 为数组）          |
| `between` / `bt` | `BETWEEN x AND y`     | 范围（`value` 为 `[lo, hi]` 二元数组） |

**select 格式：**

| 格式         | 示例                                              | 生成 SQL                       | 返回 key      |
|:-----------|:------------------------------------------------|:-----------------------------|:------------|
| 字段名        | `"name"`                                        | `"name"`                     | `name`      |
| 字段:别名      | `"price:unitPrice"`                             | `"price" AS "unitPrice"`     | `unitPrice` |
| 函数:字段      | `"count:id"`                                    | `COUNT("id") AS "count:id"`  | `count:id`  |
| 函数:字段:别名   | `"max:price:maxPrice"`                          | `MAX("price") AS "maxPrice"` | `maxPrice`  |
| 对象         | `{"field":"id","func":"count","alias":"total"}` | `COUNT("id") AS "total"`     | `total`     |
| 对象(无alias) | `{"field":"id","func":"count"}`                 | `COUNT("id") AS "count:id"`  | `count:id`  |

> **聚合函数无 alias 时**，服务端自动以 `"func:field"` 作为 AS 别名，确保返回 key 可预测且与字符串简写 `"func:field"` 一致。支持的聚合函数：`avg`、`max`、`min`、
`count`、`sum`。

**order 格式：**

| 格式  | 示例                               | 说明     |
|:----|:---------------------------------|:-------|
| 字段名 | `"name"`                         | 默认 ASC |
| 前缀  | `"desc.price"` / `"asc.name"`    | 指定方向   |
| 对象  | `{"field":"stock","dir":"desc"}` | 显式格式   |

**响应**：与 `GET /api/data/:table` 一致，含 `data` / `pageNo` / `pageSize` / `total`（分页时）。

#### POST /api/delete/:table — 条件删除

Body 直接就是 where 结构（支持上述所有 where 格式）：

```json
// 数组
[["price", "lt", 10], ["is_active", "eq", 0]]

// 单条件简写
["age", "gt", 30]

// 逻辑组合
[{"op": "or", "cond": [["name", "like", "%test%"], ["stock", "lt", 10]]}]
```

**响应**：`{ "code": "OK", "data": { "deleted": [被删除记录的主键列表] } }`

```json
{ "code": "OK", "data": { "deleted": [3, 7, 12] } }
```

---

### 5.5 数据操作接口（URL 参数模式，适合 CLI 调试）

> 以下接口使用 URL 查询参数传递条件，适合 curl/命令行快速调试。前端推荐使用 5.4 节的 POST Body 接口。

#### GET /api/data/:table/:id — 按主键查询

- SQL: `SELECT * FROM table WHERE pk = :id AND owner = :userId`（有 owner 时）
- 表无主键时返回 `TABLE_ERROR`
- 记录不存在时 `data` 为 `null`，`code` 仍为 `OK`
- 返回结果自动去掉 `owner` 字段

#### POST /api/data/:table — 创建

- 请求体：单个 JSON 对象或 JSON 数组（批量创建）
- 自动注入 `owner` 字段（有 owner 的表）
- 主键冲突返回 `CONFLICT`
- 成功返回：`{ "code": "OK", "data": { "created": [1, 2, 3] } }`（`created` 为插入记录的主键值列表）

#### PUT /api/data/:table — Upsert（不存在创建，存在增量更新）

- 请求体同 POST
- 有主键且记录存在 → `UPDATE SET` 仅传入字段（增量覆盖，未传字段不修改）
- 无主键或记录不存在 → `INSERT`
- 成功返回：`{ "code": "OK", "data": { "created": [新建主键列表], "updated": [更新主键列表] } }`

#### DELETE /api/data/:table/:id — 按主键删除

- SQL: `DELETE FROM table WHERE pk = :id AND owner = :userId`
- 表无主键时返回 `TABLE_ERROR`
- 响应：`{ "code": "OK", "data": { "deleted": [被删除的主键值] } }`（如 `{ "deleted": [1] }`，未找到则 `{ "deleted": [] }`）

#### DELETE /api/data/:table — 按条件批量删除

支持与 GET 完全相同的 WHERE 查询语法（字段条件、`or`/`and` 嵌套等），不支持 select/order/page/group。

```
DELETE /api/data/:table?age=gt.30
DELETE /api/data/:table?name=like.zhang*
DELETE /api/data/:table?or=age.gt.50,name.eq.test
```

**响应**：`{ "code": "OK", "data": { "deleted": [被删除记录的主键列表] } }`

#### GET /api/data/:table — URL 参数查询

最复杂的接口，支持通过 URL query 构建完整查询条件。

**字段条件：**

```
?field=value              → WHERE field = value（默认 eq）
?field=op.value           → WHERE field op value
```

**操作符（`.` 分割）：**

| 操作符                       | 示例                      | SQL                           |
|:--------------------------|:------------------------|:------------------------------|
| `eq`                      | `?name=eq.test`         | `name = 'test'`               |
| `ne`                      | `?status=ne.0`          | `status != 0`                 |
| `gt` / `ge` / `lt` / `le` | `?price=gt.100`         | `price > 100`                 |
| `is` / `nis`              | `?tags=is.null`         | `tags IS NULL`                |
| `like` / `nlike`          | `?name=like.Pro*`       | `name LIKE 'Pro%'`（`*` → `%`） |
| `in`                      | `?cat=in.(Books,Toys)`  | `cat IN ('Books','Toys')`     |
| `nin`                     | `?cat=nin.(Books,Toys)` | `cat NOT IN (...)`            |
| `in` (between)            | `?price=in(100...500)`  | `price BETWEEN 100 AND 500`   |

> **注意**：URL 模式的 LIKE 使用 `*` 通配符（自动转为 SQL `%`），Body 模式直接使用 `%`。

**多条件（AND）：**

```
?name=like.zhang*&age=ge.12   → name LIKE 'zhang%' AND age >= 12
```

**逻辑组合（嵌套）：**

```
?or=name.like.zhang*,age.le.33
→ (name LIKE 'zhang%' OR age <= 33)

?and=sex.eq.0,or.(age.gt.12,addr.like.*zh*)
→ sex = 0 AND (age > 12 OR addr LIKE '%zh%')
```

语法：`.` 分割字段.操作符.值，`,` 分割多个条件，`()` 嵌套子组。

**特殊参数：**

| 参数                    | 示例                          | 说明                        |
|:----------------------|:----------------------------|:--------------------------|
| `select`              | `select=name,age`           | 查询字段                      |
| `select` (别名)         | `select=price:unitPrice`    | 字段重命名                     |
| `select` (聚合)         | `select=count:id`           | 聚合，返回 key 为 `count:id`    |
| `select` (聚合+别名)      | `select=max:price:maxPrice` | 聚合+别名，返回 key 为 `maxPrice` |
| `order`               | `order=asc.age,desc.name`   | 排序（省略方向默认 ASC）            |
| `group`               | `group=category`            | 分组                        |
| `pageNo` + `pageSize` | `pageNo=1&pageSize=20`      | 分页，响应含 `total`            |

支持的聚合函数：`avg`、`max`、`min`、`count`、`sum`。

---

### 5.6 受保护的表

用户认证表（默认 `users`）**不允许**通过 CRUD/查询接口操作，必须使用 `/api/auth/*` 接口，直接访问返回 `FORBIDDEN`。

---

## 六、初始化 SQL

通过 `DB_INIT_SQL` 环境变量指定 SQL 文件（相对路径），启动时在 `ensureAuthTable` 之后自动执行：

```sql
-- init.sql 示例
INSERT INTO "users" ("username","password") VALUES ('admin','admin');

CREATE TABLE IF NOT EXISTS "products" (
  "id"    INTEGER PRIMARY KEY AUTOINCREMENT,
  "name"  TEXT NOT NULL,
  "price" REAL NOT NULL,
  "owner" INTEGER
);

INSERT INTO "products" ("name","price","owner") VALUES ('Widget', 9.99, 1);
```

配合 `bun test`：在 `.env.test` 中配置 `DB_URL=sqlite://:memory:` + `DB_INIT_SQL=init.sql`，每次测试使用全新内存库，结束后自动释放。

---

## 七、测试

```bash
bun test rest.test.ts
```

`.env.test` 示例：

```
DB_URL=sqlite://:memory:
DB_INIT_SQL=init.sql
SVR_PORT=13333
LOG_CONSOLE=false
LOG_LEVEL=ERROR
```

测试自动启动服务 → 执行全部用例 → `afterAll` 中 `server.stop(true)` 关闭服务 → 进程退出释放内存库。

---

## 八、文件结构

```
restbase/
├── bin/
│   └── restbase.ts         # CLI 入口（run/start/stop/status/log/env）
├── src/
│   ├── server.ts           # 入口：中间件、错误兜底、元数据路由、静态文件、启动
│   ├── types.ts            # 配置、类型定义、统一响应、AppError、Zod Schema
│   ├── db.ts               # 数据库连接、表结构分析、初始化 SQL、元数据查询
│   ├── auth.ts             # 鉴权中间件 + 登录/注册/资料接口
│   ├── crud.ts             # CRUD 路由 + Body 查询/删除路由
│   ├── query.ts            # URL 参数 → SQL + Body JSON → SQL
│   ├── logger.ts           # pino 日志（控制台纯文本 + 文件 pino-roll）
│   └── rest.test.ts        # 集成测试（bun test，137+ 用例）
├── client/
│   ├── restbase-client.ts  # TypeScript 前端客户端（零依赖、类型安全）
│   ├── README.md           # 前端客户端使用文档
│   └── package.json
├── documents/
│   ├── design.md           # 需求与设计文档（本文件）
│   ├── server.md           # 服务端详细使用文档
│   └── db_design.md        # 数据库设计指南
├── init.sql                # 初始化 SQL（建表 + 种子数据示例）
├── README.md               # 项目简介（索引）
├── .env / .env.test        # 环境配置
└── package.json
```

---

## 九、前端客户端

详见 [`client/README.md`](../client/README.md)。

客户端特性：

- **零依赖**、纯 TypeScript，兼容浏览器 / Node / Bun / Deno
- **链式 API**：`QueryBuilder`（select/where/order/group/page）、`DeleteBuilder`
- **类型安全 SELECT**：利用 TypeScript `const` 泛型参数 + 模板字面量类型 + 递归条件类型，编译期自动推导查询结果类型
- **DSL 函数**：`eq`、`gt`、`like`、`and`、`or`、`sel`、`agg`、`between`、`isIn` 等

```ts
const rb = new RestBase("http://localhost:3333");
await rb.auth.login("admin", "admin");

// 类型安全：data 的类型自动推导为 { name: string; price: number }[]
const data = await rb.table<Product>("products").query()
  .select("name", "price")
  .where(gt("price", 100))
  .orderDesc("price")
  .page(1, 20)
  .data();
```
