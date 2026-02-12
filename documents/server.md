# RestBase — 服务端文档

> 详细的服务端配置、API 接口说明、部署指南。

---

## 特性

- **零代码 CRUD** — 自动分析数据库表结构，生成完整 REST 接口
- **租户隔离** — 含 `owner` 字段的表自动按用户过滤数据
- **双鉴权** — JWT + Basic Auth 开箱即用
- **两套查询接口** — URL 参数（CLI 调试）+ POST Body（前端推荐）
- **类型安全的 TypeScript 客户端** — 链式 API、编译期推导 SELECT 返回类型
- **结构化日志** — pino + 文件滚动 + 请求追踪 ID
- **JSON 格式化** — 所有响应自动 pretty print

## 技术栈

| 组件                         | 用途                            |
|:---------------------------|:------------------------------|
| [Bun](https://bun.sh)      | 运行时 + 数据库驱动（`Bun.SQL`）        |
| [Hono](https://hono.dev)   | HTTP 框架 + JWT / requestId 中间件 |
| [Zod](https://zod.dev)     | 请求体校验                         |
| [pino](https://getpino.io) | 日志（控制台纯文本 + 文件 pino-roll）     |

---

## 快速开始

```bash
# 安装依赖
bun install

# 启动（默认 SQLite 内存库 + init.sql 种子数据）
bun run server.ts

# 指定数据库 + 端口
DB_URL=sqlite:///path/to/data.db SVR_PORT=8080 bun run server.ts

# MySQL
DB_URL=mysql://user:pass@localhost:3306/mydb bun run server.ts
```

验证服务：

```bash
# 健康检查（无需鉴权）
curl http://localhost:3333/api/health

# 注册用户
curl -X POST http://localhost:3333/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'

# Basic Auth 查询 products
curl -u admin:admin http://localhost:3333/api/data/products

# JWT 登录
TOKEN=$(curl -s -X POST http://localhost:3333/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | jq -r '.data')

curl -H "Authorization: Bearer $TOKEN" http://localhost:3333/api/data/products
```

---

## 环境变量

所有配置均有默认值，通过 `.env` 文件或环境变量覆盖：

| 变量                        | 说明                              | 默认值                 |
|:--------------------------|:--------------------------------|:--------------------|
| `SVR_PORT`                | 服务端口                            | `3333`              |
| `SVR_STATIC`              | 静态文件目录（相对路径），支持 SPA fallback    | 空（不启用）              |
| `SVR_API_LIMIT`           | API 限流：每秒每个接口最大请求数（0 = 不限流）     | `100`               |
| `SVR_CORS_ORIGIN`        | CORS 允许的来源（逗号分隔，`*` = 全部）       | `*`                 |
| `DB_URL`                  | 数据库连接串                          | `sqlite://:memory:` |
| `DB_AUTH_TABLE`           | 用户认证表名                          | `users`             |
| `DB_AUTH_FIELD`           | 数据表 owner 字段名                   | `owner`             |
| `DB_AUTH_FIELD_NULL_OPEN` | owner 为 NULL 视为公开数据             | `false`             |
| `DB_INIT_SQL`             | 启动时执行的 SQL 文件路径（相对路径）           | 空                   |
| `AUTH_JWT_SECRET`         | JWT 签名密钥                        | `restbase`          |
| `AUTH_JWT_EXP`            | JWT 过期秒数                        | `43200`（12h）        |
| `AUTH_BASIC_OPEN`         | 开启 Basic Auth                   | `true`              |
| `LOG_LEVEL`               | 日志等级 `ERROR` / `INFO` / `DEBUG` | `INFO`              |
| `LOG_CONSOLE`             | 控制台输出                           | `true`              |
| `LOG_FILE`                | 日志文件路径（如 `log/app.log`）         | 空                   |
| `LOG_RETAIN_DAYS`         | 日志文件保留天数                        | `7`                 |

---

## 数据库约定

### 用户表

服务启动时自动创建（`ensureAuthTable`），必须包含 `id`、`username`（UNIQUE）、`password` 三个字段，其余可自定义：

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
  -- 可自由添加 age, email, avatar 等字段
);
```

### 数据表

| 场景        | 条件                                          | 行为                                                   |
|:----------|:--------------------------------------------|:-----------------------------------------------------|
| 租户隔离      | 表含 `owner` 字段                               | 增删改查自动追加 `WHERE owner = 当前用户ID`，创建时自动注入              |
| 公开 + 私有混合 | 表含 `owner` + `DB_AUTH_FIELD_NULL_OPEN=true` | `WHERE (owner = 用户ID OR owner IS NULL)`，NULL 记录所有人可见 |
| 全局可见      | 表无 `owner` 字段                               | 所有认证用户可访问全部数据                                        |

```sql
-- 租户隔离表
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL,
  owner INTEGER  -- 关联 users.id，自动隔离
);

-- 全局表（所有用户可见）
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT,
  message TEXT
);
```

---

## 初始化 SQL

通过 `DB_INIT_SQL` 指定 SQL 文件，服务启动时在用户表创建后自动执行：

```bash
# .env
DB_INIT_SQL=init.sql
```

```sql
-- init.sql
INSERT INTO "users" ("username","password") VALUES ('admin','admin');

CREATE TABLE IF NOT EXISTS "products" (
  "id"    INTEGER PRIMARY KEY AUTOINCREMENT,
  "name"  TEXT NOT NULL,
  "price" REAL NOT NULL,
  "owner" INTEGER
);

INSERT INTO "products" ("name","price","owner") VALUES ('Widget', 9.99, 1);
```

支持 `--` 单行注释，语句以 `;` 分隔。文件不存在时输出警告日志并跳过。

---

## 测试

```bash
bun test rest.test.ts
```

`.env.test` 配置：

```
DB_URL=sqlite://:memory:
DB_INIT_SQL=init.sql
SVR_PORT=13333
LOG_CONSOLE=false
LOG_LEVEL=ERROR
```

`bun test` 自动设置 `NODE_ENV=test` 并加载 `.env.test` → 启动服务 → 执行用例 → `server.stop(true)` 关闭 → 进程退出释放内存库。

---

## API 接口

### 统一响应格式

**所有接口统一返回 HTTP 200 + JSON**（包括业务错误）：

```json
{
  "code": "OK",
  "message": "错误时的详细信息",
  "data": "任意 JSON 结构",
  "pageNo": 1,
  "pageSize": 20,
  "total": 100
}
```

| code               | 说明                           |
|:-------------------|:-----------------------------|
| `OK`               | 成功                           |
| `AUTH_ERROR`       | 鉴权失败（未登录/密码错误/Token过期/用户已存在） |
| `VALIDATION_ERROR` | Zod 请求体校验失败                  |
| `NOT_FOUND`        | 表不存在                         |
| `CONFLICT`         | 记录已存在（主键冲突）                  |
| `TABLE_ERROR`      | 表无主键（不支持按ID操作）               |
| `FORBIDDEN`        | 禁止操作用户表（需使用 /api/auth/*）     |
| `QUERY_ERROR`      | 查询语法错误                       |
| `RATE_LIMITED`     | API 请求频率超限                   |
| `SYS_ERROR`        | 系统异常                         |

---

### 健康检查

```
GET /api/health       ← 无需鉴权
```

返回实例运行状态、资源占用等非敏感元信息：

```json
{
  "code": "OK",
  "data": {
    "status": "healthy",
    "name": "my-api",
    "port": 3333,
    "pid": 12345,
    "cwd": "/home/user/my-project",
    "logFile": "/home/user/my-project/log/app.log",
    "startedAt": "2026-02-11T10:00:00.000Z",
    "uptime": 3600,
    "memory": {
      "rss": 52428800,
      "heapUsed": 12345678,
      "heapTotal": 20971520,
      "external": 1048576
    },
    "cpu": {
      "user": 1500000,
      "system": 300000
    }
  }
}
```

| 字段 | 说明 |
|:---|:---|
| `status` | 固定 `"healthy"` |
| `name` | 实例名称（`SVR_NAME`，未设置时省略） |
| `port` | 服务端口 |
| `pid` | 进程 PID |
| `cwd` | 进程工作目录（绝对路径） |
| `logFile` | 日志文件路径（绝对路径，未配置时省略） |
| `startedAt` | 进程启动时间（ISO 8601） |
| `uptime` | 进程运行时长（秒） |
| `memory.rss` | 常驻内存（bytes） |
| `memory.heapUsed` | 已用堆内存（bytes） |
| `memory.heapTotal` | 堆内存总量（bytes） |
| `memory.external` | V8 外部内存（bytes） |
| `cpu.user` | 用户态 CPU 时间（微秒） |
| `cpu.system` | 内核态 CPU 时间（微秒） |

---

### 元数据接口

> 所有元数据接口需鉴权。返回的元数据可用于前端动态生成表单和表格。

#### GET /api/meta/tables — 所有表元数据

```bash
curl -u admin:admin http://localhost:3333/api/meta/tables
```

```json
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
        { "name": "price", "type": "real", "isNumeric": true },
        { "name": "owner", "type": "integer", "isNumeric": true }
      ]
    },
    {
      "name": "logs",
      "pk": "id",
      "hasOwner": false,
      "columns": [...]
    }
  ]
}
```

> 不含用户表（`users`）。每张表包含名称、主键名（无主键为 `null`）、是否含 owner、完整列信息（名称、数据库类型、是否数值）。

#### GET /api/meta/tables/:name — 单表元数据

```bash
curl -u admin:admin http://localhost:3333/api/meta/tables/products
```

返回单张表的元数据（结构同上）。表不存在或为用户表时 `data` 返回 `null`。

#### GET /api/meta/sync — 运行时同步表结构

```bash
curl -u admin:admin http://localhost:3333/api/meta/sync
```

重新扫描数据库，刷新内存中的表元数据缓存。返回同步后的全部表元数据。适用于运行期间通过 SQL 新建了表或修改了表结构的场景。

---

### 鉴权接口

#### POST /api/auth/register — 注册

```bash
curl -X POST http://localhost:3333/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"123456"}'
```

```json
{ "code": "OK", "data": "eyJhbGciOiJIUzI1NiIs..." }
```

成功返回 JWT token。用户已存在返回 `AUTH_ERROR`。

#### POST /api/auth/login — 登录

```bash
curl -X POST http://localhost:3333/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"123456"}'
```

成功返回 JWT token。密码错误返回 `AUTH_ERROR`。

> **JWT payload**: `{ sub: username, uid: userId, iat, exp }`

#### GET /api/auth/profile — 获取用户资料

```bash
curl -H 'Authorization: Bearer <token>' http://localhost:3333/api/auth/profile
```

```json
{ "code": "OK", "data": { "username": "alice", "age": 26, "email": "alice@example.com" } }
```

返回当前用户完整记录，**去掉 `id` 和 `password`**。

#### POST /api/auth/profile — 更新用户资料

```bash
curl -X POST http://localhost:3333/api/auth/profile \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"age":27,"password":"newpass"}'
```

增量更新：仅更新表中实际存在的列，`id` 不可修改，不存在的 key 忽略。支持更新 `password`。

---

### 前端查询/删除接口（POST JSON Body）

> 前端推荐使用以下接口，通过 JSON Body 传递复杂查询条件。配套 TypeScript 客户端见 [`client/README.md`](../client/README.md)。

#### POST /api/query/:table — 复杂查询

```bash
curl -X POST http://localhost:3333/api/query/products \
  -u admin:admin \
  -H 'Content-Type: application/json' \
  -d '{
    "select": ["name", "price:unitPrice", "count:id:total"],
    "where": [["price","gt",100], {"op":"or","cond":[["category","Electronics"],["is_active","eq",1]]}],
    "order": [{"field":"price","dir":"desc"}],
    "group": ["category"],
    "pageNo": 1,
    "pageSize": 10
  }'
```

##### where 格式

支持以下所有写法，`cond` 内递归支持嵌套：

| 写法  | 示例                                       | 说明              |
|:----|:-----------------------------------------|:----------------|
| 二元组 | `["name", "test"]`                       | 默认 `eq`         |
| 三元组 | `["price", "gt", 100]`                   | 指定操作符           |
| 对象  | `{"field":"stock","op":"ge","value":50}` | 显式格式            |
| 逻辑组 | `{"op":"or","cond":[...]}`               | `and`/`or` 嵌套组合 |
| 单条件 | `"where": ["id","eq",1]`                 | where 本身为元组     |

##### 操作符

| 操作符              | SQL                 | 值格式             |
|:-----------------|:--------------------|:----------------|
| `eq`             | `=`                 | 标量              |
| `ne`             | `!=`                | 标量              |
| `gt` / `ge`      | `>` / `>=`          | 标量              |
| `lt` / `le`      | `<` / `<=`          | 标量              |
| `is`             | `IS NULL`           | `null`          |
| `nis`            | `IS NOT NULL`       | `null`          |
| `like` / `nlike` | `LIKE` / `NOT LIKE` | 字符串（直接用 `%`）    |
| `in` / `nin`     | `IN` / `NOT IN`     | 数组 `[1, 2, 3]`  |
| `between` / `bt` | `BETWEEN x AND y`   | 二元数组 `[lo, hi]` |

##### select 格式

| 格式         | 示例                                              | 生成 SQL                       | 返回 key      |
|:-----------|:------------------------------------------------|:-----------------------------|:------------|
| 字段名        | `"name"`                                        | `"name"`                     | `name`      |
| 字段:别名      | `"price:unitPrice"`                             | `"price" AS "unitPrice"`     | `unitPrice` |
| 函数:字段      | `"count:id"`                                    | `COUNT("id") AS "count:id"`  | `count:id`  |
| 函数:字段:别名   | `"max:price:maxPrice"`                          | `MAX("price") AS "maxPrice"` | `maxPrice`  |
| 对象(有alias) | `{"field":"id","func":"count","alias":"total"}` | `COUNT("id") AS "total"`     | `total`     |
| 对象(无alias) | `{"field":"id","func":"count"}`                 | `COUNT("id") AS "count:id"`  | `count:id`  |

> **聚合无 alias 时**自动以 `"func:field"` 作为 AS 别名，保证返回 key 可预测。支持函数：`avg` / `max` / `min` / `count` / `sum`。

##### order 格式

| 格式  | 示例                               |
|:----|:---------------------------------|
| 字段名 | `"name"` → ASC                   |
| 前缀  | `"desc.price"` / `"asc.name"`    |
| 对象  | `{"field":"stock","dir":"desc"}` |

##### 分页

传入 `pageNo` + `pageSize`，响应自动附带 `total` / `pageNo` / `pageSize`。

#### POST /api/delete/:table — 条件删除

Body 直接是 where 结构：

```bash
# 多条件
curl -X POST http://localhost:3333/api/delete/products \
  -u admin:admin \
  -H 'Content-Type: application/json' \
  -d '[["price","lt",10],["is_active","eq",0]]'

# 单条件简写
curl -X POST http://localhost:3333/api/delete/products \
  -u admin:admin \
  -H 'Content-Type: application/json' \
  -d '["category","eq","deprecated"]'

# 逻辑组合
curl -X POST http://localhost:3333/api/delete/products \
  -u admin:admin \
  -H 'Content-Type: application/json' \
  -d '[{"op":"or","cond":[["name","like","%test%"],["stock","lt",10]]}]'
```

```json
{ "code": "OK", "data": { "deleted": [3, 7, 12] } }
```

> `deleted` 为被删除记录的主键值列表（而非数量），便于前端同步本地状态。

---

### 数据操作接口（URL 参数模式）

> 适合 curl / 命令行快速调试。前端推荐使用上方 POST Body 接口。

#### GET /api/data/:table/:id — 按主键查询

```bash
curl -u admin:admin http://localhost:3333/api/data/products/1
```

- 有 owner 的表自动限定当前用户
- 不存在时 `data: null`，`code: "OK"`
- 表无主键时返回 `TABLE_ERROR`
- 返回结果自动去掉 `owner` 字段

#### POST /api/data/:table — 创建

```bash
# 单条
curl -X POST -u admin:admin \
  -H 'Content-Type: application/json' \
  http://localhost:3333/api/data/products \
  -d '{"name":"Widget","price":29.9,"stock":100}'

# 批量
curl -X POST -u admin:admin \
  -H 'Content-Type: application/json' \
  http://localhost:3333/api/data/products \
  -d '[{"name":"A","price":10},{"name":"B","price":20}]'
```

- 自动注入 `owner`（有 owner 的表）
- 主键冲突返回 `CONFLICT`
- 成功返回 `{ "code": "OK", "data": { "created": [101, 102] } }`（`created` 为新建记录的主键值列表）

#### PUT /api/data/:table — Upsert

```bash
curl -X PUT -u admin:admin \
  -H 'Content-Type: application/json' \
  http://localhost:3333/api/data/products \
  -d '[{"id":1,"price":88.8},{"name":"New","price":50}]'
```

- 有主键且记录存在 → `UPDATE SET` 仅传入字段（增量覆盖，未传字段不修改）
- 无主键或记录不存在 → `INSERT`
- 成功返回 `{ "code": "OK", "data": { "created": [102], "updated": [1] } }`（区分新建和更新的主键）

#### DELETE /api/data/:table/:id — 按主键删除

```bash
curl -X DELETE -u admin:admin http://localhost:3333/api/data/products/1
```

```json
{ "code": "OK", "data": { "deleted": [1] } }
```

> 未找到时返回 `{ "deleted": [] }`。

#### DELETE /api/data/:table — URL 参数条件删除

支持与 GET 完全相同的 WHERE 查询语法：

```bash
curl -X DELETE -u admin:admin 'http://localhost:3333/api/data/products?price=lt.10'
curl -X DELETE -u admin:admin 'http://localhost:3333/api/data/products?or=price.gt.900,stock.lt.5'
```

```json
{ "code": "OK", "data": { "deleted": [3, 7, 12] } }
```

> `deleted` 为被删除记录的主键值列表。

#### GET /api/data/:table — URL 参数查询

**字段条件：**

```bash
# 等值（默认 eq）
curl -u admin:admin 'http://localhost:3333/api/data/products?category=Books'

# 比较操作符
curl -u admin:admin 'http://localhost:3333/api/data/products?price=gt.100&stock=le.50'

# LIKE（* 自动转 %）
curl -u admin:admin 'http://localhost:3333/api/data/products?name=like.Pro*'

# IS NULL / IS NOT NULL
curl -u admin:admin 'http://localhost:3333/api/data/products?tags=is.null'
curl -u admin:admin 'http://localhost:3333/api/data/products?name=nis.null'

# IN
curl -u admin:admin 'http://localhost:3333/api/data/products?category=in.(Books,Toys,Food)'

# NOT IN
curl -u admin:admin 'http://localhost:3333/api/data/products?category=nin.(Books,Toys)'

# BETWEEN（... 语法）
curl -u admin:admin 'http://localhost:3333/api/data/products?price=in(100...500)'
```

**多条件（AND）：**

```bash
curl -u admin:admin 'http://localhost:3333/api/data/products?name=like.Pro*&price=gt.100'
```

**逻辑组合（嵌套）：**

```bash
# OR
curl -u admin:admin 'http://localhost:3333/api/data/products?or=price.gt.900,stock.lt.10'

# AND + 嵌套 OR
curl -u admin:admin 'http://localhost:3333/api/data/products?and=category.eq.Books,or.(price.gt.500,stock.lt.10)'

# 字段条件 + OR 混合
curl -u admin:admin 'http://localhost:3333/api/data/products?is_active=eq.1&or=category.eq.Books,category.eq.Toys'
```

> 语法：`.` 分割字段.操作符.值，`,` 分割多个条件，`()` 嵌套子组。

**SELECT / ORDER / GROUP / 分页：**

```bash
# 选择字段
curl -u admin:admin 'http://localhost:3333/api/data/products?select=name,price'

# 字段别名
curl -u admin:admin 'http://localhost:3333/api/data/products?select=price:unitPrice'

# 聚合（返回 key 为 "count:id"）
curl -u admin:admin 'http://localhost:3333/api/data/products?select=count:id'

# 聚合 + 别名（返回 key 为 "maxPrice"）
curl -u admin:admin 'http://localhost:3333/api/data/products?select=max:price:maxPrice,min:price:minPrice'

# 分组统计
curl -u admin:admin 'http://localhost:3333/api/data/products?select=category,count:id:total,avg:price:avgPrice&group=category'

# 排序
curl -u admin:admin 'http://localhost:3333/api/data/products?order=desc.price,asc.name'

# 分页（响应含 total）
curl -u admin:admin 'http://localhost:3333/api/data/products?pageNo=1&pageSize=10'

# 综合
curl -u admin:admin 'http://localhost:3333/api/data/products?price=gt.50&select=name,price&order=desc.price&pageNo=1&pageSize=5'
```

> **注意**：URL 模式 LIKE 使用 `*` 通配符（自动转 SQL `%`），Body 模式直接使用 `%`。

---

## API 限流

基于令牌桶算法，按 `METHOD + PATH` 维度对每个 API 接口独立限流：

```bash
# 设置每秒每个接口最多 200 次请求
SVR_API_LIMIT=200 bun run server.ts

# 关闭限流
SVR_API_LIMIT=0 bun run server.ts
```

- 默认 `100 req/s`，适配 4 核 8G 节点正常使用
- 超限返回 `{ "code": "RATE_LIMITED", "message": "Rate limit exceeded (100 req/s)" }`
- 响应头 `Retry-After: 1` 提示客户端 1 秒后重试
- 仅对 `/api/*` 生效，静态文件不受限流影响
- 粒度为接口级别（`GET /api/data/products` 与 `POST /api/data/products` 独立计数）

---

## CORS 跨域

通过 `SVR_CORS_ORIGIN` 环境变量配置，默认允许所有来源：

```bash
# 允许所有来源（默认）
SVR_CORS_ORIGIN=*

# 仅允许指定域名
SVR_CORS_ORIGIN=https://example.com

# 多个域名（逗号分隔）
SVR_CORS_ORIGIN=https://a.com,https://b.com
```

- 允许方法：`GET` / `POST` / `PUT` / `DELETE` / `OPTIONS`
- 允许请求头：`Content-Type` / `Authorization` / `X-Request-Id`
- 暴露响应头：`X-Request-Id`（前端可读取请求追踪 ID）
- Preflight 缓存：24 小时

---

## 静态文件托管

通过 `SVR_STATIC` 指定前端静态文件目录，RestBase 会自动托管该目录下的所有文件，并支持 SPA fallback（未匹配路由返回 `index.html`）：

```bash
# .env
SVR_STATIC=public
```

前端打包产物（如 Vite 的 `dist/`）放到 `public/` 目录即可通过同一端口访问：

```bash
# 目录结构
restbase/
├── public/          ← 前端打包产物
│   ├── index.html
│   └── assets/
├── server.ts
└── .env
```

- API 路由（`/api/*`）优先匹配，不会被静态文件拦截
- 不配置 `SVR_STATIC` 则不启用静态托管
- 文件更新后无需重启服务，下次请求自动返回最新内容

---

## 日志

### 日志配置

| 变量                | 说明                         | 默认     |
|:------------------|:---------------------------|:-------|
| `LOG_LEVEL`       | `ERROR` / `INFO` / `DEBUG` | `INFO` |
| `LOG_CONSOLE`     | 控制台输出（纯文本）                 | `true` |
| `LOG_FILE`        | 文件路径（NDJSON 格式）            | 空      |
| `LOG_RETAIN_DAYS` | 文件保留天数                     | `7`    |

### 日志级别

| 级别      | 输出内容                                |
|:--------|:------------------------------------|
| `ERROR` | 仅错误日志                               |
| `INFO`  | 每个请求：requestId、method、path、耗时(ms)   |
| `DEBUG` | INFO + 完整 headers、请求体、响应体、SQL 语句及参数 |

### 文件滚动策略

- **按天**：每天零点 → `app.log.2025-02-10`
- **按大小**：超 20MB → `app.log.2025-02-10.1`、`app.log.2025-02-10.2`
- 当前活跃文件始终为配置的原始路径
- 超过保留天数的归档自动清理

### 请求追踪

每个请求通过 Hono `requestId` 中间件分配唯一 UUID，也可通过 `X-Request-Id` 请求头携带自定义 ID。所有日志行包含 requestId。

---

## 文件结构

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
│   ├── logger.ts           # pino 日志（控制台 + 文件滚动）
│   └── rest.test.ts        # 集成测试（bun test，137+ 用例）
├── client/
│   ├── restbase-client.ts  # TypeScript 前端客户端（零依赖）
│   ├── README.md           # 前端客户端文档
│   └── package.json
├── documents/
│   ├── design.md           # 需求与设计文档
│   ├── server.md           # 服务端详细文档（本文件）
│   └── db_design.md        # 数据库设计指南
├── init.sql                # 初始化 SQL（建表 + 种子数据示例）
├── README.md               # 项目简介
├── .env / .env.test        # 环境配置
└── package.json
```

---

## 前端客户端

详见 [`client/README.md`](../client/README.md)。

```ts
import RestBase, { eq, gt, or, agg, between, sel } from "./client/restbase-client";

const rb = new RestBase("http://localhost:3333");
await rb.auth.login("admin", "admin");

interface Product { id: number; name: string; price: number; stock: number; category: string }
const products = rb.table<Product>("products");

// 类型安全 select：data 类型自动推导为 { name: string; price: number }[]
const data = await products.query()
  .select("name", "price")
  .where(gt("price", 100))
  .orderDesc("price")
  .page(1, 20)
  .data();

// 聚合 + 分组：data 类型为 { category: string; total: number; "avg:price": number }[]
const stats = await products.query()
  .select("category", agg("count", "id", "total"), agg("avg", "price"))
  .groupBy("category")
  .data();

// 条件删除
await products.deleteWhere()
  .where(or(gt("price", 900), eq("stock", 0)))
  .exec();
```

---

## License

MIT
