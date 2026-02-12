# RestBase

> 零代码通用 REST 服务 — 连接 SQLite / MySQL，自动将数据表通过 REST API 暴露。

## 特性

- **零代码 CRUD** — 自动分析表结构，生成完整 REST 接口
- **租户隔离** — `owner` 字段自动按用户隔离数据，支持 NULL 公开模式
- **双鉴权** — JWT + Basic Auth 开箱即用
- **两套查询** — URL 参数（CLI 调试）+ POST Body（前端推荐），支持复杂 WHERE / SELECT / ORDER / GROUP / 分页
- **类型安全客户端** — 零依赖 TypeScript 客户端，链式 API，编译期推导 SELECT 返回类型
- **静态文件托管** — 可选挂载前端打包产物，API 与前端同端口
- **结构化日志** — pino + 文件滚动 + 请求追踪 ID
- **单文件部署** — `bun build --compile` 编译为独立二进制，支持交叉编译

## 快速开始

### 方式一：全局安装（推荐）

```bash
bun install -g @dtdyq/restbase
```

安装后在任意目录使用 `restbase` 命令。所有配置通过 `.env` 文件读取：

```bash
# 交互式配置 .env（已存在则用当前值作为默认）
restbase env

# 前台启动（读取当前目录 .env）
restbase run

# 后台启动（daemon 模式）
restbase start

# 查看运行中的实例（含健康状态）
restbase status

# 查看某个实例的实时日志（支持 PID 或 SVR_NAME）
restbase log <pid|name>

# 停止（支持 PID、SVR_NAME 或 all）
restbase stop <pid|name>   # 停止指定实例
restbase stop all          # 停止所有实例
```

更新到最新版：

```bash
bun install -g @dtdyq/restbase@latest
```

### 方式二：从源码运行

```bash
bun install
bun run src/server.ts
```

### 验证

```bash
# 健康检查（返回实例状态 + 资源占用 + cwd + logFile）
curl http://localhost:3333/api/health
# → { "code": "OK", "data": { "status": "healthy", "port": 3333, "pid": 12345, "cwd": "/path/to/dir", "uptime": 60, "memory": {...}, "cpu": {...} } }

# Basic Auth 查询
curl -u admin:admin http://localhost:3333/api/data/products
```

### 前端客户端

独立 npm 包，零依赖：

```bash
bun add @dtdyq/restbase-client
```

```ts
import RestBase, { gt } from "@dtdyq/restbase-client";

const rb = new RestBase();  // 同源部署不传参
await rb.auth.login("admin", "admin");
const data = await rb.table("products").query().where(gt("price", 100)).data();

// 多节点负载均衡（所有节点连同一 DB）
const rb2 = new RestBase(["http://node1:3333", "http://node2:3333"]);
await rb2.auth.login("admin", "admin"); // 一次登录，token 共享
```

详见 [client/README.md](client/README.md)。

## 构建与部署

```bash
bun run build              # 编译为当前平台独立二进制

# 运行二进制（无需 Bun 运行时）
./restbase
```

## 环境变量

| 变量                        | 说明                         | 默认值                 |
|:--------------------------|:---------------------------|:--------------------|
| `SVR_NAME`                | 实例名称（`status` 中显示）         | 空                   |
| `SVR_PORT`                | 服务端口                       | `3333`              |
| `SVR_STATIC`              | 静态文件目录（前端托管）               | 空                   |
| `SVR_API_LIMIT`           | API 限流（每秒每接口请求数）           | `100`               |
| `SVR_CORS_ORIGIN`        | CORS 允许的来源（逗号分隔，`*`=全部）  | `*`                 |
| `DB_URL`                  | 数据库连接串                     | `sqlite://:memory:` |
| `DB_AUTH_TABLE`           | 用户表名                       | `users`             |
| `DB_AUTH_FIELD`           | owner 字段名                  | `owner`             |
| `DB_AUTH_FIELD_NULL_OPEN` | owner=NULL 视为公开            | `false`             |
| `DB_INIT_SQL`             | 启动时执行的 SQL 文件              | 空                   |
| `AUTH_JWT_SECRET`         | JWT 密钥                     | `restbase`          |
| `AUTH_JWT_EXP`            | JWT 过期秒数                   | `43200`             |
| `AUTH_BASIC_OPEN`         | 开启 Basic Auth              | `true`              |
| `LOG_LEVEL`               | `ERROR` / `INFO` / `DEBUG` | `INFO`              |
| `LOG_CONSOLE`             | 控制台输出                      | `true`              |
| `LOG_FILE`                | 日志文件路径                     | 空                   |
| `LOG_RETAIN_DAYS`         | 日志保留天数                     | `7`                 |

## 测试

```bash
bun test src/rest.test.ts    # 137+ 用例
```

## 文档

| 文档                                               | 内容                                                |
|:-------------------------------------------------|:--------------------------------------------------|
| [documents/server.md](documents/server.md)       | 服务端详细文档 — 配置、全部 API 接口说明与示例、日志、部署                 |
| [client/README.md](client/README.md)             | 前端客户端文档 — 安装、API 速查、QueryBuilder 链式调用、类型安全 SELECT |
| [documents/db_design.md](documents/db_design.md) | 数据库设计指南 — 表结构规范、约束、索引、设计模式与检查清单                   |
| [documents/design.md](documents/design.md)       | 需求与设计文档 — 架构设计、技术规格、完整接口定义                        |

## CLI 命令

```
restbase <command> [arguments]

Commands:
  run              前台启动服务（读取当前目录 .env）
  start            后台启动（daemon 模式）
  stop <pid|name|all>  停止后台实例（支持 PID、SVR_NAME 或 all）
  status               查看运行中的实例（含健康检查）
  log <pid|name>       实时查看实例日志（支持 PID 或 SVR_NAME）
  env              交互式 .env 配置（创建或重新配置）
  version          显示版本号
  help             显示帮助
```

所有配置通过 `.env` 文件管理，可在 `.env` 中设置 `SVR_NAME` 为实例命名。

实例管理完全无状态：通过 `ps` 自动发现运行中的实例，通过 `/api/health` 获取实例详情。
daemon 模式默认日志存放在 `~/.restbase/logs/`。

## 文件结构

```
restbase/
├── bin/
│   └── restbase.ts         # CLI 入口（run/start/stop/status）
├── src/
│   ├── server.ts           # 服务启动
│   ├── types.ts            # 配置 + 类型 + Zod Schema
│   ├── db.ts               # 数据库
│   ├── auth.ts             # 鉴权
│   ├── crud.ts             # CRUD 路由
│   ├── query.ts            # SQL 生成
│   ├── logger.ts           # 日志
│   └── rest.test.ts        # 集成测试
├── client/
│   ├── restbase-client.ts  # 前端客户端（独立 npm 包 @dtdyq/restbase-client）
│   ├── README.md           # 客户端文档
│   └── package.json
├── documents/
│   ├── design.md           # 需求设计文档
│   ├── server.md           # 服务端文档
│   └── db_design.md        # 数据库设计指南
├── init.sql                # 初始化 SQL
├── .env / .env.test        # 环境配置
└── package.json
```

## License

MIT
