/**
 * server.ts — 入口文件
 *
 * 职责：
 *   1. 安全检查
 *   2. 初始化数据库（失败终止）
 *   3. 创建 Hono 应用 / CORS 中间件
 *   4. requestId 中间件（自动生成或读取 X-Request-Id）
 *   5. API 限流中间件（令牌桶算法，每秒每 API）
 *   6. 最外层日志中间件（INFO: requestId/method/path/ms；DEBUG: +headers/body/response/SQL）
 *   7. 全局错误兜底（任何异常统一返回 HTTP 200 + 标准 JSON）
 *   8. 健康检查接口
 *   9. 鉴权中间件（JWT + Basic Auth）
 *   10. 注册 auth / CRUD 路由 / 元数据接口
 *   11. 静态文件托管（可选）
 *   12. 启动 Bun HTTP 服务
 *
 * 启动命令:  bun run server.ts
 */
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { cfg, ok, AppError, reqStore, type AppEnv, type ApiRes } from "./types.ts";
import { log } from "./logger.ts";
import { initDb, getTablesMeta, getTableMetaByName, syncTablesMeta } from "./db.ts";
import { authMiddleware, registerAuthRoutes } from "./auth.ts";
import { registerCrudRoutes } from "./crud.ts";

/* ═══════════ 1. 安全检查 ═══════════ */

if (cfg.jwtSecret === "restbase") {
  log.warn("AUTH_JWT_SECRET is using default value! Set a strong secret in production.");
}

/* ═══════════ 2. 初始化数据库 ═══════════ */

try {
  await initDb();
} catch (err) {
  log.fatal({ err }, "Database init failed");
  process.exit(1);
}

/* ═══════════ 2. 创建 Hono 应用 ═══════════ */

const app = new Hono<AppEnv>();

/* ═══════════ 3. CORS 中间件 ═══════════ */

app.use("*", cors({
  origin: "*",                     // 允许所有来源（生产环境可改为具体域名）
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  exposeHeaders: ["X-Request-Id"],
  maxAge: 86400,                   // preflight 缓存 24 小时
}));

/* ═══════════ 4. Request ID 中间件 ═══════════ */
/* 优先读取请求头 X-Request-Id，没有则自动生成 UUID */

app.use("*", requestId());

/* ═══════════ 5. API 限流中间件（滑动窗口，每秒每 IP） ═══════════ */

if (cfg.apiLimit > 0) {
  /** API 路径 → { tokens: 剩余令牌, lastRefill: 上次填充时间戳 } */
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();

  app.use("/api/*", async (c, next) => {
    const key = `${c.req.method} ${c.req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = { tokens: cfg.apiLimit, lastRefill: now };
      buckets.set(key, bucket);
    }

    /* 按经过的时间补充令牌（令牌桶算法） */
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(cfg.apiLimit, bucket.tokens + elapsed * cfg.apiLimit);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      c.res = new Response(
        JSON.stringify({ code: "RATE_LIMITED", message: `Rate limit exceeded (${cfg.apiLimit} req/s)` }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json", "Retry-After": "1" } },
      );
      return;
    }

    bucket.tokens -= 1;
    return next();
  });

  log.info({ limit: cfg.apiLimit }, `API rate limit: ${cfg.apiLimit} req/s per API`);
}

/* ═══════════ 6. 日志中间件（最外层） ═══════════ */

app.use("*", async (c, next) => {
  const start = Date.now();
  const requestId = c.get("requestId");

  /* 将 requestId 注入 AsyncLocalStorage，下游（如 db.run）可自动获取 */
  await reqStore.run({ requestId }, async () => {
    /* DEBUG: 打印请求详情 */
    if (cfg.logLevel === "DEBUG") {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k] = v));
      log.debug({ requestId, method: c.req.method, path: c.req.path, headers }, "← request");
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        try {
          log.debug({ requestId, body: await c.req.raw.clone().text() }, "← body");
        } catch { /* ignore */ }
      }
    }

    await next();

    /* JSON 响应默认格式化（pretty print） */
    const ct = c.res.headers.get("Content-Type");
    if (ct?.includes("application/json")) {
      const body = await c.res.json();
      c.res = new Response(JSON.stringify(body, null, 2), c.res);
    }

    const ms = Date.now() - start;

    /* INFO / DEBUG: 打印请求摘要（含 requestId） */
    if (cfg.logLevel !== "ERROR") {
      log.info({ requestId, method: c.req.method, path: c.req.path, ms }, "→ response");
    }

    /* DEBUG: 打印响应体 */
    if (cfg.logLevel === "DEBUG") {
      try {
        log.debug({ requestId, body: await c.res.clone().text() }, "→ body");
      } catch { /* ignore */ }
    }
  });
});

/* ═══════════ 7. 全局错误兜底（始终 HTTP 200） ═══════════ */

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ code: err.code, message: err.message } as ApiRes);
  }
  /* 非业务错误：打印堆栈，返回通用错误码 */
  log.error({ err }, "Unhandled error");
  return c.json({
    code: "SYS_ERROR",
    message: err.message || "Internal server error",
  } as ApiRes);
});

/* ═══════════ 8. 健康检查（公开） ═══════════ */

app.get("/api/health", (c) => c.json(ok({ status: "healthy" })));

/* ═══════════ 9. 鉴权中间件 ═══════════ */

app.use("/api/*", authMiddleware);

/* ═══════════ 10. 注册路由 ═══════════ */

registerAuthRoutes(app);
registerCrudRoutes(app);

/* ═══════════ 11. 元数据接口 ═══════════ */

app.get("/api/meta/tables", (c) => c.json(ok(getTablesMeta())));

app.get("/api/meta/tables/:name", (c) => {
  const data = getTableMetaByName(c.req.param("name"));
  return c.json(ok(data));
});

app.get("/api/meta/sync", async (c) => {
  const data = await syncTablesMeta();
  return c.json(ok(data));
});

/* ═══════════ 12. 静态文件托管（可选） ═══════════ */

if (cfg.staticDir) {
  /* 静态资源 */
  app.use("/*", serveStatic({ root: cfg.staticDir }));
  /* SPA fallback：所有未匹配路由返回 index.html */
  app.use("/*", serveStatic({ root: cfg.staticDir, path: "index.html" }));
  log.info({ dir: cfg.staticDir }, "Static file serving enabled");
}

/* ═══════════ 13. 启动服务 ═══════════ */

export const server = Bun.serve({ port: cfg.port, fetch: app.fetch });
log.info({ port: cfg.port }, `Server started http://localhost:${cfg.port}`);
