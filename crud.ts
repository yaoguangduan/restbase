/**
 * crud.ts — 通用 CRUD 路由 + Body 模式查询/删除
 *
 * ── 数据操作（/api/data，URL 参数模式，适合 CLI 调试） ──
 * GET    /api/data/:table/:id  — 按主键查单条
 * POST   /api/data/:table      — 创建（object 或 array），已存在则报错
 * PUT    /api/data/:table      — 不存在创建、存在增量覆盖（upsert）
 * DELETE /api/data/:table/:id  — 按主键删除单条
 * DELETE /api/data/:table      — 按条件批量删除（WHERE 语法同 GET）
 * GET    /api/data/:table      — 复杂条件列表查询（URL query 参数）
 *
 * ── 前端接口（POST JSON Body，适合前端调用） ──
 * POST   /api/query/:table     — Body 传入 select/where/order/group/分页
 * POST   /api/delete/:table    — Body 传入 where 条件
 *
 * 含 owner 字段的表自动按当前用户过滤
 * auth 表不允许通过此接口操作（使用 /api/auth/* ）
 */
import type {Hono} from "hono";
import {zValidator} from "@hono/zod-validator";
import {
    type AppEnv, AppError, cfg, ok, ownerCond, paged, q,
    zodHook, bodyQuerySchema, bodyDeleteSchema, bodyDataSchema,
    type BodyQuery, type BodyWhereInput,
} from "./types.ts";
import {getTable, isAuthTable, run, type TblMeta} from "./db.ts";
import {buildBodyDeleteSQL, buildBodyListSQL, buildDeleteSQL, buildListSQL} from "./query.ts";

/* ═══════════ 注册路由 ═══════════ */

export function registerCrudRoutes(app: Hono<AppEnv>) {
    /* ══════════════════════════════════════════════════════════
       前端接口（POST JSON Body）
       ══════════════════════════════════════════════════════════ */

    /* ── POST /api/query/:table — Body 查询 ── */
    app.post("/api/query/:table", zValidator("json", bodyQuerySchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const userId = c.get("userId");
        const body = c.req.valid("json") as BodyQuery;

        const {
            sql, countSql, values, countValues, pageNo, pageSize,
        } = buildBodyListSQL(tbl, body, userId);

        const rows = (await run(sql, values)) as any[];
        const data = stripOwner(rows, tbl);

        if (pageNo !== undefined && pageSize !== undefined) {
            const [countRow] = (await run(countSql, countValues)) as any[];
            return c.json(paged(data, pageNo, pageSize, Number(countRow?.total ?? 0)));
        }
        return c.json(ok(data));
    });

    /* ── POST /api/delete/:table — Body 条件删除 ── */
    app.post("/api/delete/:table", zValidator("json", bodyDeleteSchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const userId = c.get("userId");
        const body = c.req.valid("json")

        const {sql, values} = buildBodyDeleteSQL(tbl, body, userId);
        const ids = await collectDeletedIds(tbl, sql, values);
        await run(sql, values);
        return c.json(ok({deleted: ids}));
    });

    /* ══════════════════════════════════════════════════════════
       数据操作（URL 参数模式，适合 CLI 调试）
       ══════════════════════════════════════════════════════════ */

    /* ── GET /api/data/:table/:id — 查单条 ── */
    app.get("/api/data/:table/:id", async (c) => {
        const {table: tName, id} = c.req.param();
        const tbl = requireTable(tName);
        if (!tbl.pk)
            throw new AppError("TABLE_ERROR", `Table "${tName}" has no primary key`);

        const pkCol = tbl.colMap.get(tbl.pk)!;
        const params: unknown[] = [pkCol.isNumeric ? Number(id) : id];
        let sql = `SELECT *
                   FROM ${q(tName)}
                   WHERE ${q(tbl.pk)} = $1`;

        if (tbl.hasOwner) {
            sql += ` AND ${ownerCond(2)}`;
            params.push(c.get("userId"));
        }

        const rows = await run(sql, params);
        if (rows.length === 0) return c.json(ok(null));

        const row = {...(rows[0] as any)};
        if (tbl.hasOwner) delete row[cfg.ownerField];
        return c.json(ok(row));
    });

    /* ── POST /api/data/:table — 创建（存在则报错） ── */
    app.post("/api/data/:table", zValidator("json", bodyDataSchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const body = c.req.valid("json");
        const items: Record<string, unknown>[] = Array.isArray(body) ? body : [body];
        const userId = c.get("userId");
        const created: unknown[] = [];

        for (const item of items) {
            if (tbl.pk && item[tbl.pk] !== undefined) {
                const exist = await run(
                    `SELECT 1
                     FROM ${q(tbl.name)}
                     WHERE ${q(tbl.pk)} = $1`,
                    [item[tbl.pk]],
                );
                if (exist.length > 0)
                    throw new AppError(
                        "CONFLICT",
                        `Record ${tbl.pk}=${item[tbl.pk]} already exists`,
                    );
            }
            created.push(await insertRow(tbl, item, userId));
        }
        return c.json(ok({created}));
    });

    /* ── PUT /api/data/:table — 不存在创建，存在增量覆盖 ── */
    app.put("/api/data/:table", zValidator("json", bodyDataSchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const body = c.req.valid("json");
        const items: Record<string, unknown>[] = Array.isArray(body) ? body : [body];
        const userId = c.get("userId");
        const created: unknown[] = [];
        const updated: unknown[] = [];

        for (const item of items) {
            if (tbl.pk && item[tbl.pk] !== undefined) {
                if (await existsRow(tbl, item[tbl.pk], userId)) {
                    await updateRow(tbl, item, userId);
                    updated.push(item[tbl.pk]);
                    continue;
                }
            }
            created.push(await insertRow(tbl, item, userId));
        }
        return c.json(ok({created, updated}));
    });

    /* ── DELETE /api/data/:table/:id — 按主键删除单条 ── */
    app.delete("/api/data/:table/:id", async (c) => {
        const {table: tName, id} = c.req.param();
        const tbl = requireTable(tName);
        if (!tbl.pk)
            throw new AppError("TABLE_ERROR", `Table "${tName}" has no primary key`);

        const pkCol = tbl.colMap.get(tbl.pk)!;
        const pkVal = pkCol.isNumeric ? Number(id) : id;
        const params: unknown[] = [pkVal];
        let sql = `DELETE
                   FROM ${q(tName)}
                   WHERE ${q(tbl.pk)} = $1`;
        if (tbl.hasOwner) {
            sql += ` AND ${ownerCond(2)}`;
            params.push(c.get("userId"));
        }
        const result = await run(sql, params);
        const deleted = (result as any).count > 0 ? [pkVal] : [];
        return c.json(ok({deleted}));
    });

    /* ── DELETE /api/data/:table — 按条件批量删除（URL query） ── */
    app.delete("/api/data/:table", async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const userId = c.get("userId");

        const params: Record<string, string> = {};
        const url = new URL(c.req.url);
        for (const [k, v] of url.searchParams.entries()) params[k] = v;

        const {sql, values} = buildDeleteSQL(tbl, params, userId);
        const ids = await collectDeletedIds(tbl, sql, values);
        await run(sql, values);
        return c.json(ok({deleted: ids}));
    });

    /* ── GET /api/data/:table — 复杂条件列表查询（URL query） ── */
    app.get("/api/data/:table", async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const userId = c.get("userId");

        const params: Record<string, string> = {};
        const url = new URL(c.req.url);
        for (const [k, v] of url.searchParams.entries()) params[k] = v;

        const {
            sql, countSql, values, countValues, pageNo, pageSize,
        } = buildListSQL(tbl, params, userId);

        const rows = (await run(sql, values)) as any[];
        const data = stripOwner(rows, tbl);

        if (pageNo !== undefined && pageSize !== undefined) {
            const [countRow] = (await run(countSql, countValues)) as any[];
            return c.json(paged(data, pageNo, pageSize, Number(countRow?.total ?? 0)));
        }
        return c.json(ok(data));
    });
}

/* ═══════════ 内部工具 ═══════════ */

/**
 * 在执行 DELETE 之前，先用相同 WHERE 条件 SELECT 出即将被删的主键列表。
 * 将 DELETE SQL 改写为 SELECT pk FROM ... WHERE ...
 */
async function collectDeletedIds(
    tbl: TblMeta, deleteSql: string, values: unknown[],
): Promise<unknown[]> {
    if (!tbl.pk) return [];
    /* 把 "DELETE ... FROM ..." 替换为 "SELECT pk FROM ..."（SQL 模板可能含换行） */
    const selectSql = deleteSql.replace(
        /^DELETE\s+FROM/i,
        `SELECT ${q(tbl.pk)} FROM`,
    );
    const rows = await run(selectSql, values);
    return rows.map((r: any) => r[tbl.pk!]);
}

/** 去掉 owner 字段 */
function stripOwner(rows: any[], tbl: TblMeta): any[] {
    if (!tbl.hasOwner) return rows;
    return rows.map((r) => {
        const row = {...r};
        delete row[cfg.ownerField];
        return row;
    });
}

/** 校验表名：禁止直接操作 auth 表、表必须存在 */
function requireTable(name: string): TblMeta {
    if (isAuthTable(name))
        throw new AppError("FORBIDDEN", "Use /api/auth/* for auth table");
    const tbl = getTable(name);
    if (!tbl) throw new AppError("NOT_FOUND", `Table "${name}" not found`);
    return tbl;
}

/** 判断行是否存在（带 owner 过滤） */
async function existsRow(
    tbl: TblMeta, pkVal: unknown, userId: number,
): Promise<boolean> {
    const params: unknown[] = [pkVal];
    let sql = `SELECT 1
               FROM ${q(tbl.name)}
               WHERE ${q(tbl.pk!)} = $1`;
    if (tbl.hasOwner) {
        sql += ` AND ${ownerCond(2)}`;
        params.push(userId);
    }
    return (await run(sql, params)).length > 0;
}

/** 插入一行，返回主键值 */
async function insertRow(
    tbl: TblMeta, item: Record<string, unknown>, userId: number,
): Promise<unknown> {
    const cols: string[] = [];
    const vals: unknown[] = [];

    for (const [k, v] of Object.entries(item)) {
        /* 禁止用户自行指定 owner（防止伪造身份） */
        if (k === cfg.ownerField && tbl.hasOwner) continue;
        if (tbl.colMap.has(k)) {
            cols.push(k);
            vals.push(v);
        }
    }

    /* 自动填充 owner（始终使用当前用户 ID） */
    if (tbl.hasOwner) {
        cols.push(cfg.ownerField);
        vals.push(userId);
    }

    const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
    await run(
        `INSERT INTO ${q(tbl.name)} (${cols.map(q).join(", ")})
         VALUES (${ph})`,
        vals,
    );

    /* 获取插入的主键 */
    if (tbl.pk && item[tbl.pk] !== undefined) return item[tbl.pk];
    if (tbl.pk) {
        const [row] = cfg.isSqlite
            ? await run(`SELECT last_insert_rowid() AS id`)
            : await run(`SELECT LAST_INSERT_ID() AS id`);
        return (row as any).id;
    }
    return null;
}

/** 增量更新一行（仅更新传入的字段） */
async function updateRow(
    tbl: TblMeta, item: Record<string, unknown>, userId: number,
) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let n = 1;

    for (const [k, v] of Object.entries(item)) {
        /* 跳过主键和 owner 字段（owner 不可被用户修改） */
        if (k === tbl.pk) continue;
        if (k === cfg.ownerField && tbl.hasOwner) continue;
        if (tbl.colMap.has(k)) {
            sets.push(`${q(k)} = $${n++}`);
            vals.push(v);
        }
    }
    if (sets.length === 0) return;

    let sql = `UPDATE ${q(tbl.name)}
               SET ${sets.join(", ")}
               WHERE ${q(tbl.pk!)} = $${n++}`;
    vals.push(item[tbl.pk!]);
    if (tbl.hasOwner) {
        sql += ` AND ${ownerCond(n++)}`;
        vals.push(userId);
    }
    await run(sql, vals);
}
