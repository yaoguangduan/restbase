# RestBase Client

> 零依赖 TypeScript 前端客户端，用于访问 RestBase REST API。兼容浏览器、Node.js、Bun、Deno。

---

## 安装

直接将 `restbase-client.ts` 拷贝到项目中即可，无需安装任何依赖：

```ts
import RestBase, {
  eq, ne, gt, ge, lt, le,
  isNull, isNotNull,
  like, nlike,
  isIn, notIn, between,
  and, or,
  sel, agg,
} from "./restbase-client";
```

---

## 接口路由总览

| 接口 | 方法 | 说明 | 客户端方法 |
|:-----|:-----|:-----|:-----------|
| `/api/health` | GET | 健康检查 | `rb.health()` |
| `/api/auth/login` | POST | 登录 | `rb.auth.login()` |
| `/api/auth/register` | POST | 注册 | `rb.auth.register()` |
| `/api/auth/profile` | GET | 获取用户资料 | `rb.auth.getProfile()` |
| `/api/auth/profile` | POST | 更新用户资料 | `rb.auth.updateProfile()` |
| `/api/meta/tables` | GET | 所有表元数据 | `rb.tables()` |
| `/api/meta/tables/:name` | GET | 单表元数据 | `rb.tableMeta(name)` |
| `/api/meta/sync` | GET | 同步表结构 | `rb.syncMeta()` |
| `/api/query/:table` | **POST** | **Body 查询（前端推荐）** | `table.query().exec()` |
| `/api/delete/:table` | **POST** | **Body 条件删除** | `table.deleteWhere().exec()` |
| `/api/data/:table` | POST | 创建 | `table.create()` |
| `/api/data/:table` | PUT | Upsert | `table.put()` |
| `/api/data/:table/:id` | GET | 按主键获取 | `table.getByPk()` |
| `/api/data/:table/:id` | DELETE | 按主键删除 | `table.deleteByPk()` |

---

## 快速开始

```ts
import RestBase, { eq, gt, or, agg, sel } from "./restbase-client";

const rb = new RestBase("http://localhost:3333");

// JWT 登录（自动保存 token）
await rb.auth.login("admin", "admin");

// 查询
const products = rb.table("products");
const list = await products.query()
  .where(gt("price", 100))
  .orderDesc("price")
  .page(1, 20)
  .data();
```

---

## RestBase — 主入口

```ts
const rb = new RestBase("http://localhost:3333");
```

| 方法 | 返回类型 | 说明 |
|:-----|:---------|:-----|
| `rb.auth` | `AuthClient` | 鉴权客户端 |
| `rb.table<T>(name)` | `TableClient<T>` | 获取表操作客户端（可指定泛型） |
| `rb.health()` | `Promise<ApiResponse>` | 健康检查 |
| `rb.tables()` | `Promise<ApiResponse<TableMeta[]>>` | 获取所有表元数据（不含 users） |
| `rb.tableMeta(name)` | `Promise<ApiResponse<TableMeta \| null>>` | 获取单表元数据（不存在返回 null） |
| `rb.syncMeta()` | `Promise<ApiResponse<TableMeta[]>>` | 运行时同步 DB 表结构 |
| `rb.setHeader(k, v)` | `this` | 设置自定义请求头 |
| `rb.setRequestId(id)` | `this` | 设置请求追踪 ID（`X-Request-Id`） |

**TableMeta 结构：**

```ts
interface TableMeta {
  name: string;
  pk: string | null;        // 主键名，无主键为 null
  hasOwner: boolean;         // 是否含 owner 字段（租户隔离）
  columns: {
    name: string;
    type: string;            // 数据库类型（如 "integer"、"text"、"real"）
    isNumeric: boolean;
  }[];
}
```

---

## Meta — 元数据

```ts
// 获取所有表元数据（不含 users）
const all = await rb.tables();
// all.data → [{ name, pk, hasOwner, columns: [...] }]

// 获取指定表的元数据
const meta = await rb.tableMeta("products");
// meta.data → { name: "products", pk: "id", hasOwner: true, columns: [...] }
// 表不存在时 meta.data → null

// 运行时同步（DB 新建表后刷新缓存）
const synced = await rb.syncMeta();
// synced.data → 同步后的全部表元数据
```

---

## AuthClient — 鉴权

```ts
// 登录（成功后自动保存 JWT token）
const res = await rb.auth.login("admin", "password");
// res.data → JWT token 字符串

// 注册（成功后自动保存 JWT token）
await rb.auth.register("newuser", "password");

// 获取当前用户资料（去掉 id 和 password）
const profile = await rb.auth.getProfile();
// profile.data → { username: "admin", age: 26, ... }

// 泛型版本
const p = await rb.auth.getProfile<{ username: string; age: number }>();

// 更新资料（增量：仅传入要改的字段）
await rb.auth.updateProfile({ age: 27, email: "new@example.com" });

// Token 管理
rb.auth.setToken(savedToken);   // 从 localStorage 恢复
rb.auth.getToken();             // 获取当前 token
rb.auth.logout();               // 清除 token

// 切换为 Basic Auth（每次请求携带用户名密码）
rb.auth.useBasicAuth("admin", "admin");
```

---

## TableClient — 表操作

```ts
// 无泛型：操作返回 Record<string, unknown>
const products = rb.table("products");

// 有泛型：获得完整类型提示
interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number;
  rating: number;
  is_active: number;
}
const typedProducts = rb.table<Product>("products");
```

| 方法 | 说明 | 返回 |
|:-----|:-----|:-----|
| `table.query()` | 创建链式查询（POST /api/query/:table） | `QueryBuilder<T>` |
| `table.getByPk(id)` | 按主键获取（GET /api/data/:table/:id） | `ApiResponse<T \| null>` |
| `table.create(data)` | 创建（POST /api/data/:table） | `ApiResponse<{ created: unknown[] }>` |
| `table.put(data)` | Upsert（PUT /api/data/:table） | `ApiResponse<{ created: unknown[]; updated: unknown[] }>` |
| `table.deleteByPk(id)` | 按主键删除（DELETE /api/data/:table/:id） | `ApiResponse<{ deleted: unknown[] }>` |
| `table.deleteWhere()` | 创建链式条件删除（POST /api/delete/:table） | `DeleteBuilder` |

### CRUD 示例

```ts
// 按主键获取
const one = await products.getByPk(42);
// one.data → Product | null

// 创建（单条）
const cr = await products.create({ name: "Widget", price: 29.9, stock: 100 });
// cr.data → { created: [101] }  ← 新建记录的主键列表

// 创建（批量）
const batch = await products.create([
  { name: "A", price: 10, stock: 50 },
  { name: "B", price: 20, stock: 30 },
]);
// batch.data → { created: [102, 103] }

// Upsert（不存在创建，存在增量更新）
const up = await products.put([{ id: 1, price: 88.8 }, { name: "New", price: 50 }]);
// up.data → { created: [104], updated: [1] }  ← 区分新建与更新

// 按主键删除
const del = await products.deleteByPk(1);
// del.data → { deleted: [1] }  ← 被删除的主键列表（未找到则 []）
```

---

## QueryBuilder — 链式查询

通过 `table.query()` 创建，内部使用 `POST /api/query/:table`，条件通过 JSON Body 传递。

```ts
const result = await products.query()
  .where(gt("price", 50), lt("stock", 100))
  .select("name", "price")
  .orderDesc("price")
  .page(1, 20)
  .exec();
```

### `.where(...conditions)` — 添加 WHERE 条件

多次调用为 AND 关系。

```ts
// 简单条件
.where(eq("category", "Books"))

// 多条件（AND）
.where(gt("price", 10), lt("price", 100))

// 逻辑组合
.where(or(eq("category", "Books"), eq("category", "Toys")))

// 深度嵌套
.where(
  or(
    and(eq("category", "Electronics"), gt("price", 500)),
    and(lt("stock", 10), eq("is_active", 1)),
  )
)
```

### `.select(...fields)` — 类型安全投影

`select()` 利用 TypeScript `const` 泛型参数 + 模板字面量类型 + 递归条件类型，在**编译期**自动推导查询结果类型 `S`。`exec()` / `data()` / `first()` 的返回类型都跟随 `S` 变化。

```ts
import { sel, agg } from "./restbase-client";

interface Product {
  id: number; name: string; category: string;
  price: number; stock: number; rating: number;
}
const products = rb.table<Product>("products");
```

#### 纯字段选择

```ts
// 返回类型: { name: string; price: number }[]
const a = await products.query()
  .select("name", "price")
  .data();

a[0].name;   // ✅ string
a[0].price;  // ✅ number
a[0].stock;  // ❌ 编译错误 — 类型中不存在
```

#### 字段重命名 `sel(field, alias)`

```ts
// 返回类型: { unitPrice: number; name: string }[]
const b = await products.query()
  .select(sel("price", "unitPrice"), "name")
  .data();

b[0].unitPrice;  // ✅ number（price 被映射为 unitPrice）
```

#### 聚合 `agg(fn, field)` / `agg(fn, field, alias)`

```ts
// 有 alias → 返回类型: { category: string; total: number }[]
const c = await products.query()
  .select("category", agg("count", "id", "total"))
  .groupBy("category")
  .data();

c[0].total;  // ✅ number

// 无 alias → 默认 key 为 "fn:field"
// 返回类型: { category: string; "count:id": number; "avg:price": number }[]
const d = await products.query()
  .select("category", agg("count", "id"), agg("avg", "price"))
  .groupBy("category")
  .data();

d[0]["count:id"];  // ✅ number
d[0]["avg:price"]; // ✅ number
```

> **聚合无 alias 时**，客户端自动以 `"fn:field"` 作为 alias 发送给服务端，服务端生成 `AS "fn:field"`。类型侧使用模板字面量 `` `${Fn}:${F}` `` 保留。

#### 字符串模板写法

```ts
// 字段:别名（field ∈ keyof T）→ { unitPrice: T["price"] }
.select("price:unitPrice")

// 函数:字段（func ∉ keyof T）→ { "count:id": number }
.select("count:id")

// 函数:字段:别名 → { total: number }
.select("count:id:total")
```

#### 类型推导规则汇总

| 参数格式 | 示例 | 推导结果 |
|:---------|:-----|:---------|
| `keyof T` 字符串 | `"name"` | `{ name: T["name"] }` |
| `"func:field:alias"` | `"count:id:total"` | `{ total: number }` |
| `"field:alias"` (field ∈ T) | `"price:unitPrice"` | `{ unitPrice: T["price"] }` |
| `"func:field"` (func ∉ T) | `"count:id"` | `{ "count:id": number }` |
| `sel(field)` | `sel("name")` | `{ name: T["name"] }` |
| `sel(field, alias)` | `sel("price","up")` | `{ up: T["price"] }` |
| `agg(fn, field)` | `agg("count","id")` | `{ "count:id": number }` |
| `agg(fn, field, alias)` | `agg("count","id","total")` | `{ total: number }` |

### `.orderAsc()` / `.orderDesc()` — 排序

```ts
.orderAsc("name")       // ORDER BY name ASC
.orderDesc("price")     // ORDER BY price DESC
.orderAsc("name").orderDesc("price")  // 多字段
```

### `.groupBy()` — 分组

```ts
.groupBy("category")
.groupBy("category", "is_active")   // 多字段
```

### `.page(pageNo, pageSize)` — 分页

```ts
.page(1, 20)   // pageNo=1, pageSize=20
// 响应自动包含 total / pageNo / pageSize
```

### 执行方法

| 方法 | 返回类型 | 说明 |
|:-----|:---------|:-----|
| `.exec()` | `Promise<ApiResponse<S[]>>` | 完整响应（S 为 select 推导的投影类型，默认 T） |
| `.data()` | `Promise<S[]>` | 仅返回数据数组 |
| `.first()` | `Promise<S \| null>` | 返回第一条（自动 `page(1,1)`） |
| `.build()` | `Record<string, unknown>` | 构建请求 Body（不执行，用于调试） |

---

## DeleteBuilder — 条件删除

通过 `table.deleteWhere()` 创建，内部使用 `POST /api/delete/:table`。

```ts
// 简单条件
const res = await products.deleteWhere()
  .where(gt("price", 900))
  .exec();
// res → { code: "OK", data: { deleted: [3, 7, 12] } }  ← 被删除的主键列表

// 复杂条件
await products.deleteWhere()
  .where(or(
    gt("price", 900),
    like("name", "%test%"),
  ))
  .exec();

// 嵌套 AND + OR
await products.deleteWhere()
  .where(and(
    eq("is_active", 0),
    or(lt("stock", 5), gt("price", 1000)),
  ))
  .exec();
```

---

## 条件运算符速查

| 函数 | SQL | 示例 | 值类型 |
|:-----|:----|:-----|:-------|
| `eq(f, v)` | `=` | `eq("name", "test")` | 标量 |
| `ne(f, v)` | `!=` | `ne("status", 0)` | 标量 |
| `gt(f, v)` | `>` | `gt("price", 100)` | 标量 |
| `ge(f, v)` | `>=` | `ge("age", 18)` | 标量 |
| `lt(f, v)` | `<` | `lt("stock", 10)` | 标量 |
| `le(f, v)` | `<=` | `le("rating", 3)` | 标量 |
| `isNull(f)` | `IS NULL` | `isNull("desc")` | — |
| `isNotNull(f)` | `IS NOT NULL` | `isNotNull("email")` | — |
| `like(f, p)` | `LIKE` | `like("name", "%test%")` | 字符串（`%` 通配） |
| `nlike(f, p)` | `NOT LIKE` | `nlike("name", "%x%")` | 字符串 |
| `isIn(f, arr)` | `IN (...)` | `isIn("id", [1, 2, 3])` | 数组 |
| `notIn(f, arr)` | `NOT IN` | `notIn("status", [0])` | 数组 |
| `between(f, lo, hi)` | `BETWEEN` | `between("price", 10, 100)` | 两个标量 |
| `and(...c)` | `AND` | `and(eq("a",1), gt("b",2))` | Condition[] |
| `or(...c)` | `OR` | `or(eq("a",1), eq("a",2))` | Condition[] |

> **注意**：Body 模式的 LIKE 直接使用 SQL `%` 通配符，不需要用 `*` 替换。

---

## SELECT 辅助函数

| 函数 | 说明 | 示例 | 类型推导 |
|:-----|:-----|:-----|:---------|
| `sel(field)` | 选择字段 | `sel("name")` | `{ name: T["name"] }` |
| `sel(field, alias)` | 字段重命名 | `sel("price", "unitPrice")` | `{ unitPrice: T["price"] }` |
| `agg(fn, field)` | 聚合（alias 默认 `fn:field`） | `agg("count", "id")` | `{ "count:id": number }` |
| `agg(fn, field, alias)` | 聚合 + 自定义别名 | `agg("avg", "price", "avgP")` | `{ avgP: number }` |

支持的聚合函数：`avg` / `max` / `min` / `count` / `sum`

---

## 完整示例

```ts
import RestBase, {
  eq, gt, lt, le, like, or, and, agg, sel, between, isIn,
} from "./restbase-client";

const rb = new RestBase("http://localhost:3333");
await rb.auth.login("admin", "admin");

// ── 元数据 ──
const allMeta = await rb.tables();       // 所有表元数据
const prodMeta = await rb.tableMeta("products");

// ── 类型安全查询 ──
interface Product {
  id: number; name: string; category: string;
  price: number; stock: number; rating: number; is_active: number;
}
const products = rb.table<Product>("products");

// 搜索 → { name: string; price: number }[]
const search = await products.query()
  .select("name", "price")
  .where(like("name", "%Pro%"))
  .data();

// 范围 + 排序 → Product[]
const filtered = await products.query()
  .where(between("price", 100, 500), eq("is_active", 1))
  .orderDesc("price")
  .data();

// 分页 → 完整响应含 total
const page = await products.query()
  .where(gt("stock", 0))
  .page(2, 10)
  .exec();

// 分组统计 → { category: string; total: number; avgPrice: number }[]
const stats = await products.query()
  .select("category", agg("count", "id", "total"), agg("avg", "price", "avgPrice"))
  .groupBy("category")
  .data();

// 聚合无 alias → { category: string; "count:id": number }[]
const stats2 = await products.query()
  .select("category", agg("count", "id"))
  .groupBy("category")
  .data();

// 字段重命名 → { unitPrice: number }[]
const renamed = await products.query()
  .select(sel("price", "unitPrice"))
  .data();

// 复杂嵌套
const complex = await products.query()
  .where(
    or(
      and(eq("category", "Electronics"), gt("price", 500)),
      and(lt("stock", 10), eq("is_active", 1)),
    ),
  )
  .data();

// 第一条
const first = await products.query()
  .where(gt("rating", 4))
  .orderDesc("rating")
  .first();

// ── 条件删除 ──
await products.deleteWhere()
  .where(le("rating", 1))
  .exec();

// ── CRUD ──
await products.create({ name: "New", price: 50, stock: 100 });
await products.create([{ name: "A", price: 10 }, { name: "B", price: 20 }]);
await products.put({ id: 1, price: 88 });
await products.deleteByPk(99);
const one = await products.getByPk(42);
```

---

## 错误处理

所有接口统一返回 HTTP 200 + JSON，通过 `code` 判断成功/失败：

```ts
const res = await rb.auth.login("wrong", "password");
if (res.code !== "OK") {
  console.error(`[${res.code}] ${res.message}`);
  // [AUTH_ERROR] Invalid username or password
}
```

| code | 说明 |
|:-----|:-----|
| `OK` | 成功 |
| `AUTH_ERROR` | 鉴权失败（未登录/密码错误/Token过期/用户已存在） |
| `VALIDATION_ERROR` | 请求体校验失败 |
| `NOT_FOUND` | 表不存在 |
| `CONFLICT` | 记录已存在（主键冲突） |
| `TABLE_ERROR` | 表无主键（不支持按 ID 操作） |
| `FORBIDDEN` | 禁止操作用户表 |
| `QUERY_ERROR` | 查询语法错误 |
| `RATE_LIMITED` | API 请求频率超限 |
| `SYS_ERROR` | 系统异常 |

---

## ApiResponse 类型

```ts
interface ApiResponse<T = unknown> {
  code: string;       // "OK" 或错误码
  message?: string;   // 错误详情
  data: T;            // 业务数据
  pageNo?: number;    // 分页：当前页
  pageSize?: number;  // 分页：每页条数
  total?: number;     // 分页：总记录数
}
```
