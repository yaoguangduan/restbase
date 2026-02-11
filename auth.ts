/**
 * auth.ts — 鉴权中间件（JWT + Basic Auth）、登录 / 注册 / 用户资料
 *
 * 公开路径（无需鉴权）：
 *   POST /api/auth/login
 *   POST /api/auth/register
 *   GET  /api/health
 *
 * JWT payload: { sub: username, uid: userId, iat, exp }
 * Basic Auth:  Authorization: Basic base64(username:password)
 */
import type {Context, Hono, Next} from "hono";
import {sign as jwtSign, verify as jwtVerify} from "hono/jwt";
import {zValidator} from "@hono/zod-validator";
import {type AppEnv, AppError, authBodySchema, cfg, ok, q, zodHook,} from "./types.ts";
import {getTable, run} from "./db.ts";

/* ═══════════ 公开路径集合 ═══════════ */

const PUBLIC = new Set(["/api/auth/login", "/api/auth/register", "/api/health"]);

/* ═══════════ 鉴权中间件 ═══════════ */

export const authMiddleware = async (
    c: Context<AppEnv>,
    next: Next,
) => {
    if (PUBLIC.has(c.req.path)) return next();

    const header = c.req.header("Authorization") ?? "";

    /* ── JWT: Bearer <token> ── */
    if (header.startsWith("Bearer ")) {
        try {
            const payload = await jwtVerify(header.slice(7), cfg.jwtSecret, "HS256");
            c.set("userId", payload.uid as number);
            c.set("username", payload.sub as string);
            return next();
        } catch {
            /* JWT 失败 → 尝试 Basic Auth */
        }
    }

    /* ── Basic Auth: Basic base64(user:pass) ── */
    if (cfg.basicAuth && header.startsWith("Basic ")) {
        try {
            const decoded = atob(header.slice(6));
            const sep = decoded.indexOf(":");
            if (sep > 0) {
                const username = decoded.slice(0, sep);
                const password = decoded.slice(sep + 1);
                const user = await findUser(username);
                if (user && user.password === password) {
                    c.set("userId", user.id as number);
                    c.set("username", username);
                    return next();
                }
            }
        } catch {
            /* ignore decode errors */
        }
    }

    throw new AppError("AUTH_ERROR", "Unauthorized");
};

/* ═══════════ 内部工具 ═══════════ */

async function findUser(username: string) {
    const rows = await run(
        `SELECT id, username, password
         FROM ${q(cfg.authTable)}
         WHERE username = $1`,
        [username],
    );
    return rows.length > 0 ? (rows[0] as any) : null;
}

async function issueToken(uid: number, username: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return jwtSign(
        {sub: username, uid, iat: now, exp: now + cfg.jwtExp},
        cfg.jwtSecret,
    );
}

/* ═══════════ 注册路由 ═══════════ */

export function registerAuthRoutes(app: Hono<AppEnv>) {
    /* ── POST /api/auth/login ── */
    app.post(
        "/api/auth/login",
        zValidator("json", authBodySchema, zodHook as any),
        async (c) => {
            const {username, password} = c.req.valid("json");
            const user = await findUser(username);
            if (!user || user.password !== password)
                throw new AppError("AUTH_ERROR", "Invalid username or password");
            return c.json(ok(await issueToken(user.id, username)));
        },
    );

    /* ── POST /api/auth/register ── */
    app.post(
        "/api/auth/register",
        zValidator("json", authBodySchema, zodHook as any),
        async (c) => {
            const {username, password} = c.req.valid("json");
            if (await findUser(username))
                throw new AppError("AUTH_ERROR", `User "${username}" already exists`);
            await run(
                `INSERT INTO ${q(cfg.authTable)} (username, password)
                 VALUES ($1, $2)`,
                [username, password],
            );
            const user = await findUser(username);
            return c.json(ok(await issueToken(user.id, username)));
        },
    );

    /* ── GET /api/auth/profile — 获取当前用户资料（去掉 id 和 password） ── */
    app.get("/api/auth/profile", async (c) => {
        const userId = c.get("userId");
        const rows = await run(
            `SELECT *
             FROM ${q(cfg.authTable)}
             WHERE id = $1`,
            [userId],
        );
        if (rows.length === 0) throw new AppError("AUTH_ERROR", "User not found");
        const data = {...(rows[0] as any)};
        delete data.id;
        delete data.password;
        return c.json(ok(data));
    });

    /* ── POST /api/auth/profile — 增量更新当前用户资料 ── */
    app.post("/api/auth/profile", async (c) => {
        const userId = c.get("userId");
        const body = (await c.req.json()) as Record<string, unknown>;
        const meta = getTable(cfg.authTable)!;

        const sets: string[] = [];
        const vals: unknown[] = [];
        let n = 1;
        for (const [k, v] of Object.entries(body)) {
            /* 只更新表中实际存在的列（id 不允许修改） */
            if (meta.colMap.has(k) && k !== "id") {
                sets.push(`${q(k)} = $${n++}`);
                vals.push(v);
            }
        }
        if (sets.length === 0) return c.json(ok(null));

        vals.push(userId);
        await run(
            `UPDATE ${q(cfg.authTable)}
             SET ${sets.join(", ")}
             WHERE id = $${n}`,
            vals,
        );
        return c.json(ok(null));
    });
}
