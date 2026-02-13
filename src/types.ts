/**
 * types.ts — 全局配置、类型定义、统一响应、Zod 校验、AppError
 *
 * 所有 .env 变量均有默认值（约定大于配置）
 */
import {z} from "zod";
import {AsyncLocalStorage} from "node:async_hooks";

/* ═══════════ .env 配置 ═══════════ */

const _db = Bun.env.DB_URL ?? "sqlite://:memory:";

export const cfg = {
    /** 实例名称（用于 status 展示） */
    name: Bun.env.SVR_NAME ?? "",
    /** 服务端口 */
    port: Number(Bun.env.SVR_PORT) || 3333,
    /** 静态文件目录（相对路径，为空则不托管） */
    staticDir: Bun.env.SVR_STATIC ?? "",
    /** API 限流：每秒每个 API 接口允许的最大请求数（0 = 不限流） */
    apiLimit: Bun.env.SVR_API_LIMIT !== undefined ? Number(Bun.env.SVR_API_LIMIT) : 100,
    /** CORS 允许的来源（默认 *，生产环境建议改为具体域名，逗号分隔多个） */
    corsOrigin: Bun.env.SVR_CORS_ORIGIN ?? "*",
    /** 数据库连接字符串 */
    db: _db,
    /** 是否 SQLite（非 mysql:// 则视为 SQLite） */
    isSqlite: !_db.startsWith("mysql"),
    /** 用户认证表名 */
    authTable: Bun.env.DB_AUTH_TABLE ?? "users",
    /** 数据表中的 owner 字段名 */
    ownerField: Bun.env.DB_AUTH_FIELD ?? "owner",
    /** owner 字段为 NULL 时视为公开数据（查询自动追加 OR owner IS NULL），默认 false */
    ownerNullOpen: (Bun.env.DB_AUTH_FIELD_NULL_OPEN ?? "false") === "true",
    /** JWT 密钥 */
    jwtSecret: Bun.env.AUTH_JWT_SECRET ?? "restbase",
    /** JWT 过期秒数（默认 12 小时） */
    jwtExp: Number(Bun.env.AUTH_JWT_EXP) || 43200,
    /** 是否开启 Basic Auth（默认 true） */
    basicAuth: (Bun.env.AUTH_BASIC_OPEN ?? "true") !== "false",
    /** 日志等级 */
    logLevel: (Bun.env.LOG_LEVEL ?? "INFO").toUpperCase() as "ERROR" | "INFO" | "DEBUG",
    /** 是否输出到控制台（默认 true） */
    logConsole: (Bun.env.LOG_CONSOLE ?? "true") !== "false",
    /** 日志文件路径（不配置则不写文件） */
    logFile: Bun.env.LOG_FILE ?? "",
    /** 日志文件保留天数（默认 7） */
    logRetainDays: Number(Bun.env.LOG_RETAIN_DAYS) || 7,
    /** 初始化 SQL 文件路径（相对路径，启动时执行） */
    initSql: Bun.env.DB_INIT_SQL ?? "",
};

/**
 * 生成 owner 过滤条件 SQL 片段
 * - 默认: `"owner" = $N`
 * - ownerNullOpen=true: `("owner" = $N OR "owner" IS NULL)`
 */
export function ownerCond(paramIdx: number | string): string {
    const ph = typeof paramIdx === "string" ? paramIdx : `$${paramIdx}`;
    const base = `${q(cfg.ownerField)} = ${ph}`;
    if (cfg.ownerNullOpen) {
        return `(${base} OR ${q(cfg.ownerField)} IS NULL)`;
    }
    return base;
}

/* ═══════════ 请求上下文（AsyncLocalStorage） ═══════════ */

export const reqStore = new AsyncLocalStorage<{ requestId: string }>();

/* ═══════════ SQL 标识符引用 ═══════════ */

/** SQLite 用双引号，MySQL 用反引号 */
export const q = (id: string) => (cfg.isSqlite ? `"${id}"` : `\`${id}\``);

/* ═══════════ Hono 环境泛型 ═══════════ */

export type AppEnv = { Variables: { userId: number; username: string; requestId: string } };

/* ═══════════ 统一 JSON 响应结构 ═══════════ */

export interface ApiRes {
    code: string;
    message?: string;
    data?: unknown;
    pageNo?: number;
    pageSize?: number;
    total?: number;
}

export const ok = (data?: unknown): ApiRes => ({code: "OK", data: data ?? null});

export const paged = (
    rows: unknown[],
    pageNo: number,
    pageSize: number,
    total: number,
): ApiRes => ({code: "OK", data: rows, pageNo, pageSize, total});

/* ═══════════ 业务错误（HTTP 始终返回 200） ═══════════ */

export class AppError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "AppError";
        this.code = code;
    }
}

/* ═══════════ Zod 校验 hook（失败时返回 200 + 统一格式） ═══════════ */

export const zodHook = (result: any, _c: any) => {
    if (!result.success) {
        const msg = result.error.issues.map((i: any) => i.message).join("; ");
        return new Response(
            JSON.stringify({code: "VALIDATION_ERROR", message: msg}, null, 2),
            {status: 200, headers: {"Content-Type": "application/json"}},
        );
    }
};

/* ═══════════ Zod Schemas ═══════════ */

export const authBodySchema = z.object({
    username: z.string().min(1, "username is required"),
    password: z.string().min(1, "password is required"),
});

/* ── Body 输入类型（递归部分需手动声明类型） ── */

/** where 条件单元 */
export type BodyWhereItem =
    | [string, unknown]                             // [field, value] 默认 eq
    | [string, string, unknown]                     // [field, op, value]
    | { field: string; op: string; value?: unknown } // 对象格式
    | { op: "and" | "or"; cond: BodyWhereInput[] }; // 逻辑组合

/** where 顶层：单条件 或 条件数组 */
export type BodyWhereInput = BodyWhereItem | BodyWhereItem[];

export const bodyWhereItemSchema: z.ZodType<BodyWhereItem> = z.lazy(() =>
    z.union([
        z.tuple([z.string(), z.unknown()]),
        z.tuple([z.string(), z.string(), z.unknown()]),
        z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() }),
        z.object({ op: z.enum(["and", "or"]), cond: z.array(bodyWhereInputSchema) }),
    ]),
);

export const bodyWhereInputSchema: z.ZodType<BodyWhereInput> = z.lazy(() =>
    z.union([
        bodyWhereItemSchema,
        z.array(bodyWhereItemSchema),
    ]),
);

/** select 项 */
export const bodySelectItemSchema = z.union([
    z.string().min(1),
    z.object({ field: z.string().min(1), alias: z.string().optional(), func: z.string().optional() }),
]);
export type BodySelectItem = z.infer<typeof bodySelectItemSchema>;

/** order 项 */
export const bodyOrderItemSchema = z.union([
    z.string().min(1),
    z.object({ field: z.string().min(1), dir: z.enum(["asc", "desc"]).optional() }),
]);
export type BodyOrderItem = z.infer<typeof bodyOrderItemSchema>;

/** POST /api/query/:table — 完整查询 Body */
export const bodyQuerySchema = z.object({
    select: z.array(bodySelectItemSchema).optional(),
    where: bodyWhereInputSchema.optional(),
    order: z.array(bodyOrderItemSchema).optional(),
    group: z.array(z.string()).optional(),
    pageNo: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(1000).optional(),
});
export type BodyQuery = z.infer<typeof bodyQuerySchema>;

/** POST /api/delete/:table — 删除 Body（直接是 where 条件） */
export const bodyDeleteSchema = bodyWhereInputSchema;

/** POST /api/update/:table — 条件批量更新 Body */
export const bodyUpdateSchema = z.object({
    set: z.record(z.string(), z.unknown()),
    where: bodyWhereInputSchema,
});
export type BodyUpdate = z.infer<typeof bodyUpdateSchema>;

/** POST|PUT|PATCH /api/save/:table — 创建/更新 Body（单对象或对象数组） */
export const bodyDataSchema = z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())).min(1),
]);
