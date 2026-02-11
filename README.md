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

```bash
bun install
bun run server.ts
```

```bash
# 健康检查
curl http://localhost:3333/api/health

# Basic Auth 查询
curl -u admin:admin http://localhost:3333/api/data/products
```

## 构建与部署

```bash
bun run build              # 当前平台
bun run build:linux        # Linux x64
bun run build:linux-arm    # Linux ARM64
bun run build:mac          # macOS x64
bun run build:mac-arm      # macOS ARM64
bun run build:windows      # Windows x64

# 运行二进制（无需 Bun 运行时）
./restbase
```

## 环境变量

| 变量                        | 说明                         | 默认值                 |
|:--------------------------|:---------------------------|:--------------------|
| `SVR_PORT`                | 服务端口                       | `3333`              |
| `SVR_STATIC`              | 静态文件目录（前端托管）               | 空                   |
| `SVR_API_LIMIT`           | API 限流（每秒每接口请求数）           | `100`               |
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
bun test rest.test.ts    # 137+ 用例
```

## 文档

| 文档                                               | 内容                                                |
|:-------------------------------------------------|:--------------------------------------------------|
| [documents/server.md](documents/server.md)       | 服务端详细文档 — 配置、全部 API 接口说明与示例、日志、部署                 |
| [documents/client.md](documents/client.md)       | 前端客户端文档 — 安装、API 速查、QueryBuilder 链式调用、类型安全 SELECT |
| [documents/db_design.md](documents/db_design.md) | 数据库设计指南 — 表结构规范、约束、索引、设计模式与检查清单                   |
| [documents/design.md](documents/design.md)       | 需求与设计文档 — 架构设计、技术规格、完整接口定义                        |

## 文件结构

```
restbase/
├── server.ts            # 入口
├── types.ts             # 配置 + 类型
├── db.ts                # 数据库
├── auth.ts              # 鉴权
├── crud.ts              # CRUD 路由
├── query.ts             # SQL 生成
├── logger.ts            # 日志
├── client/
│   └── restbase-client.ts   # 前端客户端
├── documents/
│   ├── design.md        # 需求设计文档
│   ├── server.md        # 服务端文档
│   └── client.md        # 客户端文档
├── init.sql             # 初始化 SQL
├── rest.test.ts         # 集成测试
├── .env / .env.test     # 环境配置
└── package.json
```

## License

MIT
