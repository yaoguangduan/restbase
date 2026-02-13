/**
 * crud.ts — 路由注册
 *
 * ── 查询 /api/query ──
 * GET    /api/query/:table      — URL 参数查询（列表/分页/排序/聚合）
 * POST   /api/query/:table      — Body 复杂查询
 * GET    /api/query/:table/:pk  — 按主键取单条
 *
 * ── 删除 /api/delete ──
 * DELETE /api/delete/:table      — URL 参数条件删除
 * POST   /api/delete/:table      — Body 条件删除
 * DELETE /api/delete/:table/:pk  — 按主键删除单条
 *
 * ── 条件批量更新 /api/update ──
 * POST   /api/update/:table      — { set: {...}, where: ... }
 *
 * ── 记录操作 /api/save ──
 * POST   /api/save/:table        — 严格插入（存在报错）
 * PUT    /api/save/:table        — Upsert（存在更新，不存在插入）
 * PATCH  /api/save/:table        — 严格更新（不存在报错，必须带 PK）
 *
 * 含 owner 字段的表自动按当前用户过滤
 * auth 表不允许通过此接口操作（使用 /api/auth/*）
 */
import type {Hono} from "hono";
import {zValidator} from "@hono/zod-validator";
import {
    type AppEnv, AppError, cfg, ok, ownerCond, paged, q,
    zodHook, bodyQuerySchema, bodyDeleteSchema, bodyDataSchema, bodyUpdateSchema,
    type BodyQuery, type BodyWhereInput, type BodyUpdate,
} from "./types.ts";
import {getTable, isAuthTable, run, runTransaction, type TblMeta} from "./db.ts";
import {buildBodyDeleteSQL, buildBodyListSQL, buildBodyUpdateSQL, buildDeleteSQL, buildListSQL} from "./query.ts";

/* ═══════════ 类型 ═══════════ */

type Exec = (sql: string, values?: unknown[]) => Promise<any[]>;

/* ═══════════ 注册路由 ═══════════ */

export function registerCrudRoutes(app: Hono<AppEnv>) {

    /* ══════════════════════════════════════════════════════════
       /api/query — 查询
       ══════════════════════════════════════════════════════════ */

    /* ── GET /api/query/:table/:pk — 按主键取单条 ── */
    app.get("/api/query/:table/:pk", async (c) => {
        const {table: tName, pk} = c.req.param();
        const tbl = requireTable(tName);
        if (!tbl.pk)
            throw new AppError("TABLE_ERROR", `Table "${tName}" has no primary key`);

        const pkCol = tbl.colMap.get(tbl.pk)!;
        const params: unknown[] = [pkCol.isNumeric ? Number(pk) : pk];
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

    /* ── GET /api/query/:table — URL 参数查询 ── */
    app.get("/api/query/:table", async (c) => {
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

    /* ══════════════════════════════════════════════════════════
       /api/delete — 删除
       ══════════════════════════════════════════════════════════ */

    /* ── DELETE /api/delete/:table/:pk — 按主键删除单条 ── */
    app.delete("/api/delete/:table/:pk", async (c) => {
        const {table: tName, pk} = c.req.param();
        const tbl = requireTable(tName);
        if (!tbl.pk)
            throw new AppError("TABLE_ERROR", `Table "${tName}" has no primary key`);

        const pkCol = tbl.colMap.get(tbl.pk)!;
        const pkVal = pkCol.isNumeric ? Number(pk) : pk;
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

    /* ── POST /api/delete/:table — Body 条件删除 ── */
    app.post("/api/delete/:table", zValidator("json", bodyDeleteSchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const userId = c.get("userId");
        const body = c.req.valid("json");

        const {sql, values} = buildBodyDeleteSQL(tbl, body, userId);
        const ids = await transactionalDelete(tbl, sql, values);
        return c.json(ok({deleted: ids}));
    });

    /* ── DELETE /api/delete/:table — URL 参数条件删除 ── */
    app.delete("/api/delete/:table", async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const userId = c.get("userId");

        const params: Record<string, string> = {};
        const url = new URL(c.req.url);
        for (const [k, v] of url.searchParams.entries()) params[k] = v;

        const {sql, values} = buildDeleteSQL(tbl, params, userId);
        const ids = await transactionalDelete(tbl, sql, values);
        return c.json(ok({deleted: ids}));
    });

    /* ══════════════════════════════════════════════════════════
       /api/update — 条件批量更新
       ══════════════════════════════════════════════════════════ */

    /* ── POST /api/update/:table — { set, where } ── */
    app.post("/api/update/:table", zValidator("json", bodyUpdateSchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const userId = c.get("userId");
        const body = c.req.valid("json") as BodyUpdate;

        if (Object.keys(body.set).length === 0) {
            throw new AppError("VALIDATION_ERROR", "set must contain at least one field");
        }

        const {updateSql, selectSql, updateValues, selectValues} =
            buildBodyUpdateSQL(tbl, body.set, body.where, userId);

        if (!tbl.pk) {
            await run(updateSql, updateValues);
            return c.json(ok({updated: []}));
        }

        const ids = await runTransaction(async (tx) => {
            const rows = await tx(selectSql, selectValues);
            const pks = rows.map((r: any) => r[tbl.pk!]);
            if (pks.length > 0) {
                await tx(updateSql, updateValues);
            }
            return pks;
        });
        return c.json(ok({updated: ids}));
    });

    /* ══════════════════════════════════════════════════════════
       /api/save — 记录操作（POST/PUT/PATCH）
       ══════════════════════════════════════════════════════════ */

    /* ── POST /api/save/:table — 严格插入（存在报错） ── */
    app.post("/api/save/:table", zValidator("json", bodyDataSchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const body = c.req.valid("json");
        const items: Record<string, unknown>[] = Array.isArray(body) ? body : [body];
        const userId = c.get("userId");

        const created = await runTransaction(async (tx) => {
            const pks: unknown[] = [];
            for (const item of items) {
                if (tbl.pk && item[tbl.pk] !== undefined) {
                    if (await existsRowWith(tx, tbl, item[tbl.pk], userId)) {
                        throw new AppError(
                            "CONFLICT",
                            `Record ${tbl.pk}=${item[tbl.pk]} already exists`,
                        );
                    }
                }
                pks.push(await insertRowWith(tx, tbl, item, userId));
            }
            return pks;
        });
        return c.json(ok({created}));
    });

    /* ── PUT /api/save/:table — Upsert（存在更新，不存在插入） ── */
    app.put("/api/save/:table", zValidator("json", bodyDataSchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        const body = c.req.valid("json");
        const items: Record<string, unknown>[] = Array.isArray(body) ? body : [body];
        const userId = c.get("userId");

        const result = await runTransaction(async (tx) => {
            const created: unknown[] = [];
            const updated: unknown[] = [];
            for (const item of items) {
                if (tbl.pk && item[tbl.pk] !== undefined) {
                    if (await existsRowWith(tx, tbl, item[tbl.pk], userId)) {
                        await updateRowWith(tx, tbl, item, userId);
                        updated.push(item[tbl.pk]);
                        continue;
                    }
                }
                created.push(await insertRowWith(tx, tbl, item, userId));
            }
            return {created, updated};
        });
        return c.json(ok(result));
    });

    /* ── PATCH /api/save/:table — 严格更新（不存在报错，必须带 PK） ── */
    app.patch("/api/save/:table", zValidator("json", bodyDataSchema, zodHook as any), async (c) => {
        const tbl = requireTable(c.req.param("table"));
        if (!tbl.pk)
            throw new AppError("TABLE_ERROR", `Table "${c.req.param("table")}" has no primary key`);

        const body = c.req.valid("json");
        const items: Record<string, unknown>[] = Array.isArray(body) ? body : [body];
        const userId = c.get("userId");

        const updated = await runTransaction(async (tx) => {
            const pks: unknown[] = [];
            for (const item of items) {
                if (item[tbl.pk!] === undefined) {
                    throw new AppError(
                        "VALIDATION_ERROR",
                        `Primary key "${tbl.pk}" is required for PATCH`,
                    );
                }
                if (!(await existsRowWith(tx, tbl, item[tbl.pk!], userId))) {
                    throw new AppError(
                        "NOT_FOUND",
                        `Record ${tbl.pk}=${item[tbl.pk!]} not found`,
                    );
                }
                await updateRowWith(tx, tbl, item, userId);
                pks.push(item[tbl.pk!]);
            }
            return pks;
        });
        return c.json(ok({updated}));
    });
}

/* ═══════════ 内部工具 ═══════════ */

/**
 * 在事务中先 SELECT 待删除的主键列表，再执行 DELETE，保证一致性。
 */
async function transactionalDelete(
    tbl: TblMeta, deleteSql: string, values: unknown[],
): Promise<unknown[]> {
    if (!tbl.pk) {
        await run(deleteSql, values);
        return [];
    }
    const selectSql = deleteSql.replace(
        /^DELETE\s+FROM/i,
        `SELECT ${q(tbl.pk)} FROM`,
    );
    return runTransaction(async (tx) => {
        const rows = await tx(selectSql, values);
        const ids = rows.map((r: any) => r[tbl.pk!]);
        await tx(deleteSql, values);
        return ids;
    });
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
async function existsRowWith(
    exec: Exec, tbl: TblMeta, pkVal: unknown, userId: number,
): Promise<boolean> {
    const params: unknown[] = [pkVal];
    let sql = `SELECT 1
               FROM ${q(tbl.name)}
               WHERE ${q(tbl.pk!)} = $1`;
    if (tbl.hasOwner) {
        sql += ` AND ${ownerCond(2)}`;
        params.push(userId);
    }
    return (await exec(sql, params)).length > 0;
}

/** 插入一行，返回主键值 */
async function insertRowWith(
    exec: Exec, tbl: TblMeta, item: Record<string, unknown>, userId: number,
): Promise<unknown> {
    const cols: string[] = [];
    const vals: unknown[] = [];

    for (const [k, v] of Object.entries(item)) {
        if (k === cfg.ownerField && tbl.hasOwner) continue;
        if (tbl.colMap.has(k)) {
            cols.push(k);
            vals.push(v);
        }
    }

    if (tbl.hasOwner) {
        cols.push(cfg.ownerField);
        vals.push(userId);
    }

    const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
    await exec(
        `INSERT INTO ${q(tbl.name)} (${cols.map(q).join(", ")})
         VALUES (${ph})`,
        vals,
    );

    if (tbl.pk && item[tbl.pk] !== undefined) return item[tbl.pk];
    if (tbl.pk) {
        const [row] = cfg.isSqlite
            ? await exec(`SELECT last_insert_rowid() AS id`)
            : await exec(`SELECT LAST_INSERT_ID() AS id`);
        return (row as any).id;
    }
    return null;
}

/** 增量更新一行（仅更新传入的字段） */
async function updateRowWith(
    exec: Exec, tbl: TblMeta, item: Record<string, unknown>, userId: number,
) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let n = 1;

    for (const [k, v] of Object.entries(item)) {
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
    await exec(sql, vals);
}
