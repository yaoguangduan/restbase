# RestBase — 数据库设计指南

> 如何为 RestBase 设计数据库表结构，发挥最大效能并规避常见陷阱。

---

## 一、核心约束

RestBase 在启动时自动分析表结构，以下是它对数据库的**硬性要求**和**软性建议**：

| 项目 | 要求 | 说明 |
|:-----|:-----|:-----|
| 主键 | **强烈建议** | 无主键的表不支持 `GET /:id`、`DELETE /:id`、`PUT` Upsert；仅支持列表查询和 POST 插入 |
| 主键类型 | 自增整数 / UUID | RestBase 通过 `PRAGMA table_info` / `information_schema` 自动识别 PK 字段 |
| 用户表 | **必须** | 至少包含 `id`、`username`（UNIQUE）、`password` 三个字段，表名默认 `users`（可配） |
| owner 字段 | 可选 | 含此字段的表自动启用租户隔离，字段名默认 `owner`（可配） |
| 字段名 | 不限制 | 推荐 `snake_case`，避免使用 SQL 保留字（如 `order`、`group`、`select`） |

---

## 二、主键设计

### 2.1 推荐方案

**自增整数主键**（最简单、性能最优）：

```sql
-- SQLite
"id" INTEGER PRIMARY KEY AUTOINCREMENT

-- MySQL
id INT AUTO_INCREMENT PRIMARY KEY
```

**UUID 主键**（分布式场景）：

```sql
-- SQLite（TEXT 存储）
"id" TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))

-- MySQL
id CHAR(36) PRIMARY KEY DEFAULT (UUID())
```

### 2.2 注意事项

| 场景 | 行为 |
|:-----|:-----|
| POST 创建 | 返回 `{ created: [主键值列表] }` |
| PUT Upsert | 请求体中含主键且存在 → UPDATE；不含或不存在 → INSERT |
| DELETE /:id | 路径参数即主键值 |
| 复合主键 | **不支持** — RestBase 只识别单列主键 |

> 如果表确实不需要按 ID 操作（如纯日志表），可以不设主键，但会失去按 ID 查/删/Upsert 的能力。

---

## 三、用户表（Auth Table）

RestBase 启动时自动创建最小用户表，你也可以在 `DB_INIT_SQL` 中定义更丰富的结构：

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id"         INTEGER PRIMARY KEY AUTOINCREMENT,
  "username"   TEXT NOT NULL UNIQUE,
  "password"   TEXT NOT NULL,
  -- ↓ 自定义扩展字段（通过 /api/auth/profile 读写）
  "email"      TEXT,
  "avatar"     TEXT,
  "role"       TEXT DEFAULT 'user',
  "age"        INTEGER,
  "created_at" TEXT DEFAULT (datetime('now'))
);
```

**规则：**
- `id`、`username`、`password` 三个字段**不可缺少**，否则启动报错
- 扩展字段可通过 `GET /api/auth/profile` 读取、`POST /api/auth/profile` 更新
- `GET /api/auth/profile` 响应自动**去掉 `id` 和 `password`**
- 用户表**禁止**通过 CRUD 接口直接操作（返回 `FORBIDDEN`），必须使用 `/api/auth/*`

**密码安全提醒：** RestBase 当前以明文存储密码。生产环境建议在 `DB_INIT_SQL` 中插入预哈希的密码，或在前端传输前进行哈希处理。

---

## 四、owner 字段与租户隔离

### 4.1 基本模式

数据表含 `owner` 字段（默认字段名，可通过 `DB_AUTH_FIELD` 配置）时，RestBase 自动：

1. **查询** — 追加 `WHERE owner = 当前用户ID`
2. **创建** — 自动注入 `owner = 当前用户ID`（用户传入的 owner 值会被忽略）
3. **更新** — 追加 `WHERE owner = 当前用户ID`，防止越权修改
4. **删除** — 追加 `WHERE owner = 当前用户ID`，防止越权删除

```sql
-- 私有数据表：每个用户只能看到自己的订单
CREATE TABLE "orders" (
  "id"         INTEGER PRIMARY KEY AUTOINCREMENT,
  "product_id" INTEGER NOT NULL,
  "quantity"   INTEGER DEFAULT 1,
  "total"      REAL NOT NULL,
  "status"     TEXT DEFAULT 'pending',
  "created_at" TEXT DEFAULT (datetime('now')),
  "owner"      INTEGER         -- ← 关联 users.id，自动隔离
);
```

### 4.2 公开 + 私有混合模式

设置 `DB_AUTH_FIELD_NULL_OPEN=true` 后，owner 为 NULL 的记录对**所有用户可见**：

```
WHERE (owner = 当前用户ID OR owner IS NULL)
```

适用场景：

```sql
-- 模板表：系统预置模板 owner=NULL 所有人可见，用户自建模板 owner=用户ID 仅自己可见
CREATE TABLE "templates" (
  "id"    INTEGER PRIMARY KEY AUTOINCREMENT,
  "name"  TEXT NOT NULL,
  "body"  TEXT,
  "owner" INTEGER    -- NULL = 公开模板，非 NULL = 私有模板
);

-- 系统预置（所有人可见）
INSERT INTO "templates" ("name", "body", "owner") VALUES ('默认模板', '...', NULL);
-- 用户自建（仅自己可见）—— 通过 API 创建时 owner 自动注入
```

### 4.3 全局公开表

不含 `owner` 字段的表，所有已认证用户可访问全部数据：

```sql
-- 全局配置表：所有用户共享
CREATE TABLE "settings" (
  "id"    INTEGER PRIMARY KEY AUTOINCREMENT,
  "key"   TEXT NOT NULL UNIQUE,
  "value" TEXT
);

-- 操作日志：所有用户可查看
CREATE TABLE "logs" (
  "id"      INTEGER PRIMARY KEY AUTOINCREMENT,
  "level"   TEXT NOT NULL,
  "message" TEXT,
  "created_at" TEXT
);
```

### 4.4 owner 字段类型

owner 字段类型应与用户表的 `id` 字段类型一致：

| 用户表 id 类型 | owner 字段类型 |
|:---------------|:---------------|
| `INTEGER` (自增) | `INTEGER` |
| `TEXT` (UUID) | `TEXT` |
| `INT` (MySQL) | `INT` |

---

## 五、数据类型建议

### 5.1 SQLite

SQLite 是动态类型，以下为推荐的类型亲和性：

| 用途 | 类型 | 示例 |
|:-----|:-----|:-----|
| 自增 ID | `INTEGER PRIMARY KEY AUTOINCREMENT` | `"id" INTEGER PRIMARY KEY AUTOINCREMENT` |
| 短文本 | `TEXT` | `"name" TEXT NOT NULL` |
| 长文本 | `TEXT` | `"description" TEXT` |
| 整数 | `INTEGER` | `"stock" INTEGER DEFAULT 0` |
| 浮点数 | `REAL` | `"price" REAL NOT NULL` |
| 布尔值 | `INTEGER` | `"is_active" INTEGER DEFAULT 1`（0/1） |
| 日期时间 | `TEXT` | `"created_at" TEXT DEFAULT (datetime('now'))` |
| JSON | `TEXT` | `"tags" TEXT`（存 JSON 字符串） |

> SQLite 没有原生布尔和日期类型，用 INTEGER(0/1) 和 TEXT(ISO 8601) 是最佳实践。

### 5.2 MySQL

| 用途 | 类型 | 示例 |
|:-----|:-----|:-----|
| 自增 ID | `INT AUTO_INCREMENT` | `id INT AUTO_INCREMENT PRIMARY KEY` |
| 短文本 | `VARCHAR(N)` | `name VARCHAR(255) NOT NULL` |
| 长文本 | `TEXT` / `LONGTEXT` | `description TEXT` |
| 整数 | `INT` / `BIGINT` | `stock INT DEFAULT 0` |
| 浮点数 | `DECIMAL(M,D)` | `price DECIMAL(10,2) NOT NULL` |
| 布尔值 | `TINYINT(1)` | `is_active TINYINT(1) DEFAULT 1` |
| 日期时间 | `DATETIME` / `TIMESTAMP` | `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` |
| JSON | `JSON` | `tags JSON` |

### 5.3 数值类型识别

RestBase 通过正则 `/int|real|float|double|decimal|numeric/` 判断字段是否为数值型。数值型字段在查询参数中自动进行类型转换（字符串 → 数字），非数值型字段保持字符串。

**命名建议：** 如果你使用了自定义类型名，确保数值型字段的类型声明中包含上述关键词之一，否则 RestBase 会将其视为文本型。

---

## 六、约束与索引

### 6.1 推荐约束

```sql
CREATE TABLE "products" (
  "id"       INTEGER PRIMARY KEY AUTOINCREMENT,
  "name"     TEXT NOT NULL,                    -- NOT NULL：必填字段
  "sku"      TEXT UNIQUE,                      -- UNIQUE：防止重复
  "price"    REAL NOT NULL CHECK(price >= 0),  -- CHECK：业务规则
  "stock"    INTEGER DEFAULT 0,                -- DEFAULT：合理默认值
  "category" TEXT DEFAULT 'uncategorized',
  "owner"    INTEGER
);
```

| 约束 | 作用 | RestBase 行为 |
|:-----|:-----|:--------------|
| `NOT NULL` | 禁止空值 | 创建/更新时缺少必填字段 → 数据库报错 → 返回 `SYS_ERROR` |
| `UNIQUE` | 唯一约束 | 插入重复值 → 返回 `CONFLICT` |
| `CHECK` | 自定义校验 | 违反约束 → 数据库报错 → 返回 `SYS_ERROR` |
| `DEFAULT` | 默认值 | 创建时未传该字段 → 数据库自动填充 |
| `FOREIGN KEY` | 外键关联 | RestBase 不感知外键，但数据库层面仍然生效 |

> **重要：** RestBase 不做应用层校验（除 Zod 校验 auth 接口），数据完整性依赖数据库约束。**请充分利用 `NOT NULL`、`CHECK`、`UNIQUE`、`DEFAULT` 保护数据质量。**

### 6.2 索引建议

RestBase 的查询最终都转为 SQL，索引直接影响查询性能：

```sql
-- 高频查询字段加索引
CREATE INDEX idx_products_category ON "products"("category");
CREATE INDEX idx_products_price    ON "products"("price");

-- owner 字段必加索引（租户隔离表的每次查询都会用到）
CREATE INDEX idx_products_owner ON "products"("owner");

-- 组合索引（覆盖常见查询模式）
CREATE INDEX idx_products_owner_category ON "products"("owner", "category");

-- UNIQUE 索引（业务唯一性）
CREATE UNIQUE INDEX idx_products_sku ON "products"("sku");
```

**索引优先级：**

| 优先级 | 字段 | 原因 |
|:-------|:-----|:-----|
| **必须** | `owner` | 租户隔离表每次 CRUD 都有 `WHERE owner = ?` |
| **高** | 高频 WHERE 过滤字段 | 如 `category`、`status`、`created_at` |
| **高** | UNIQUE 约束字段 | 如 `sku`、`email` |
| **中** | ORDER BY 排序字段 | 如 `price`、`created_at` |
| **中** | GROUP BY 分组字段 | 如 `category`、`level` |
| **低** | 很少查询的字段 | 如 `description`、`tags` |

---

## 七、常用字段模式

### 7.1 时间戳

```sql
-- SQLite
"created_at" TEXT DEFAULT (datetime('now')),
"updated_at" TEXT

-- MySQL
created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
```

> RestBase 不会自动维护 `updated_at`。SQLite 没有 `ON UPDATE` 触发，需手动传值或使用触发器。MySQL 可用 `ON UPDATE CURRENT_TIMESTAMP` 自动更新。

### 7.2 软删除

```sql
"is_deleted" INTEGER DEFAULT 0      -- 0 = 正常，1 = 已删除
```

> RestBase 不感知软删除语义。如果你使用软删除模式，需在查询时手动带上 `is_deleted=eq.0` 条件。可通过前端客户端的 `QueryBuilder` 封装默认条件。

### 7.3 状态枚举

```sql
-- 用 TEXT 存枚举值（可读性好）
"status" TEXT DEFAULT 'draft' CHECK(status IN ('draft','published','archived'))

-- 或用 INTEGER 存编码（性能略优）
"status" INTEGER DEFAULT 0    -- 0=draft, 1=published, 2=archived
```

### 7.4 JSON 数据

```sql
-- SQLite：存为 TEXT
"tags"     TEXT,       -- '["tag1","tag2"]'
"metadata" TEXT        -- '{"key":"value"}'

-- MySQL：用原生 JSON 类型
tags     JSON,
metadata JSON
```

> RestBase 将 JSON 字段视为普通文本列，不支持 JSON 路径查询（如 `$.tags[0]`）。复杂 JSON 查询需使用数据库原生 SQL（通过 `DB_INIT_SQL` 创建视图）。

### 7.5 布尔标志

```sql
-- SQLite 推荐 INTEGER 0/1
"is_active"  INTEGER DEFAULT 1
"is_public"  INTEGER DEFAULT 0

-- MySQL 推荐 TINYINT(1)
is_active  TINYINT(1) DEFAULT 1
is_public  TINYINT(1) DEFAULT 0
```

查询示例：`?is_active=eq.1` 或 Body `["is_active", "eq", 1]`

---

## 八、表设计模式参考

### 8.1 电商商品表（租户隔离）

```sql
CREATE TABLE "products" (
  "id"          INTEGER PRIMARY KEY AUTOINCREMENT,
  "name"        TEXT NOT NULL,
  "sku"         TEXT UNIQUE,
  "category"    TEXT NOT NULL DEFAULT 'uncategorized',
  "price"       REAL NOT NULL CHECK(price >= 0),
  "cost"        REAL CHECK(cost >= 0),
  "stock"       INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  "is_active"   INTEGER DEFAULT 1,
  "tags"        TEXT,                                    -- JSON array
  "description" TEXT,
  "created_at"  TEXT DEFAULT (datetime('now')),
  "updated_at"  TEXT,
  "owner"       INTEGER                                  -- 租户隔离
);

CREATE INDEX idx_products_owner    ON "products"("owner");
CREATE INDEX idx_products_category ON "products"("category");
CREATE INDEX idx_products_active   ON "products"("is_active");
```

### 8.2 订单表（租户隔离）

```sql
CREATE TABLE "orders" (
  "id"          INTEGER PRIMARY KEY AUTOINCREMENT,
  "order_no"    TEXT NOT NULL UNIQUE,                    -- 业务单号
  "product_id"  INTEGER NOT NULL,
  "quantity"    INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
  "unit_price"  REAL NOT NULL,
  "total"       REAL NOT NULL,
  "status"      TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','shipped','completed','cancelled')),
  "remark"      TEXT,
  "created_at"  TEXT DEFAULT (datetime('now')),
  "owner"       INTEGER
);

CREATE INDEX idx_orders_owner   ON "orders"("owner");
CREATE INDEX idx_orders_status  ON "orders"("status");
CREATE INDEX idx_orders_created ON "orders"("created_at");
```

### 8.3 系统配置表（全局公开）

```sql
CREATE TABLE "app_config" (
  "id"    INTEGER PRIMARY KEY AUTOINCREMENT,
  "key"   TEXT NOT NULL UNIQUE,
  "value" TEXT,
  "desc"  TEXT
  -- 无 owner → 所有用户可见
);
```

### 8.4 消息/通知表（公开 + 私有混合）

```sql
-- 配合 DB_AUTH_FIELD_NULL_OPEN=true
CREATE TABLE "notifications" (
  "id"         INTEGER PRIMARY KEY AUTOINCREMENT,
  "title"      TEXT NOT NULL,
  "content"    TEXT,
  "type"       TEXT DEFAULT 'info',
  "is_read"    INTEGER DEFAULT 0,
  "created_at" TEXT DEFAULT (datetime('now')),
  "owner"      INTEGER    -- NULL = 系统广播（所有人可见），非 NULL = 私人通知
);

CREATE INDEX idx_notif_owner ON "notifications"("owner");
```

### 8.5 操作日志表（全局只写）

```sql
CREATE TABLE "audit_logs" (
  "id"         INTEGER PRIMARY KEY AUTOINCREMENT,
  "action"     TEXT NOT NULL,              -- 'create','update','delete'
  "table_name" TEXT NOT NULL,
  "record_id"  TEXT,
  "user_id"    INTEGER,
  "detail"     TEXT,                       -- JSON 变更详情
  "ip"         TEXT,
  "created_at" TEXT DEFAULT (datetime('now'))
  -- 无 owner → 管理员可查看全部日志
);

CREATE INDEX idx_audit_action  ON "audit_logs"("action");
CREATE INDEX idx_audit_table   ON "audit_logs"("table_name");
CREATE INDEX idx_audit_created ON "audit_logs"("created_at");
```

---

## 九、注意事项与限制

### 9.1 RestBase 不支持的特性

| 特性 | 说明 | 替代方案 |
|:-----|:-----|:---------|
| 多表联查（JOIN） | 不支持跨表关联查询 | 创建数据库视图（`CREATE VIEW`），RestBase 可查询视图 |
| 存储过程 | 不支持调用存储过程 | 在 `DB_INIT_SQL` 中创建，通过视图暴露结果 |
| 复合主键 | 仅识别单列主键 | 改用单列自增 ID + UNIQUE 联合约束 |
| 自动迁移 | 不提供 schema migration | 手动管理 SQL 文件或使用 `DB_INIT_SQL` |
| 字段级权限 | 不支持按字段控制读写权限 | 在前端客户端层面控制展示/提交的字段 |
| 乐观锁 | 不内置版本号/时间戳冲突检测 | 在表中增加 `version` 字段，业务层面自行处理 |

### 9.2 视图的妙用

对于需要 JOIN 的场景，推荐使用数据库视图：

```sql
-- init.sql 中创建视图
CREATE VIEW IF NOT EXISTS "order_details" AS
SELECT
  o.id, o.order_no, o.quantity, o.total, o.status, o.owner,
  p.name AS product_name, p.category
FROM "orders" o
LEFT JOIN "products" p ON o.product_id = p.id;
```

RestBase 会将视图当作普通表暴露，支持查询（但通常不支持写入）。

> **注意：** 视图如果包含 `owner` 字段，同样会自动启用租户隔离。

### 9.3 常见陷阱

| 陷阱 | 问题 | 解决方案 |
|:-----|:-----|:---------|
| 字段名用 SQL 保留字 | `"order"` `"group"` `"select"` 可能引起解析歧义 | 使用 `order_no`、`group_name` 等非保留字 |
| owner 字段类型不匹配 | users.id 是 INTEGER，owner 是 TEXT | 保持类型一致 |
| 缺少索引 | 大表查询缓慢 | owner 字段和高频过滤字段必须加索引 |
| 没有 NOT NULL | 意外存入空值 | 必填字段务必加 `NOT NULL` |
| 没有 DEFAULT | 创建时必须传所有字段 | 合理设置默认值，减少前端负担 |
| SQLite 大小写 | SQLite 默认 LIKE 区分大小写 | 使用 `COLLATE NOCASE` 或应用层统一小写 |
| 无主键的表做 Upsert | PUT 无法判断记录是否存在 | 每张业务表都应有主键 |

---

## 十、设计检查清单

在创建新表之前，对照以下清单：

- [ ] **主键** — 是否有单列自增主键（`id`）？
- [ ] **owner** — 是否需要租户隔离？需要则加 `owner INTEGER`
- [ ] **owner 索引** — 租户隔离表是否为 owner 创建了索引？
- [ ] **NOT NULL** — 必填字段是否都标记了 `NOT NULL`？
- [ ] **DEFAULT** — 可选字段是否设了合理的默认值？
- [ ] **UNIQUE** — 业务唯一字段（如 sku、email）是否加了唯一约束？
- [ ] **CHECK** — 数值范围、枚举值是否用 CHECK 约束保护？
- [ ] **索引** — 高频查询/排序/分组字段是否建了索引？
- [ ] **命名** — 字段名是否使用 `snake_case`，且避开 SQL 保留字？
- [ ] **类型** — 数值型字段的类型声明是否包含 `int`/`real`/`float`/`decimal` 等关键词？
