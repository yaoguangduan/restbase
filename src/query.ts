/**
 * query.ts — 查询条件 → SQL
 *
 * 两种入口：
 *   A) URL 查询参数（GET/DELETE，用于命令行调试）
 *      buildListSQL / buildDeleteSQL
 *   B) JSON Body（POST /api/query、POST /api/delete，用于前端）
 *      buildBodyListSQL / buildBodyDeleteSQL
 *
 * URL 语法：
 *   普通条件:  ?field=value  或  ?field=op.value
 *   操作符:    eq ne ge gt le lt is nis(ns) like nlike in nin
 *   逻辑组合:  ?or=f.op.v,f2.op.v2  → (cond OR cond)
 *   特殊参数:  select / order / pageNo / pageSize / group
 *
 * Body 语法：
 *   where: 数组/元组/对象，支持嵌套 and/or
 *   select: 字符串或对象数组
 *   order: 字符串或对象数组
 *   group: 字段名数组
 */
import type {ColMeta, TblMeta} from "./db.ts";
import {
    AppError, cfg, ownerCond, q,
    type BodyWhereItem, type BodyWhereInput, type BodySelectItem,
    type BodyOrderItem, type BodyQuery,
} from "./types.ts";

/* ─── 操作符映射 ─── */
const OP: Record<string, string> = {
    eq: "=", ne: "!=", ge: ">=", gt: ">", le: "<=", lt: "<",
};
const ALL_OPS = new Set([
    ...Object.keys(OP), "is", "nis", "ns", "like", "nlike", "in", "nin",
]);
const AGG_FUNCS = new Set(["avg", "max", "min", "count", "sum"]);
const RESERVED = new Set([
    "select", "order", "pageNo", "pageSize", "group", "or", "and",
]);

/* ─── 输出结构 ─── */
export interface ListSQL {
    sql: string;
    countSql: string;
    values: unknown[];
    countValues: unknown[];
    pageNo?: number;
    pageSize?: number;
}

export interface DeleteSQL {
    sql: string;
    values: unknown[];
}

/* ─── 内部类型 ─── */
interface Ctx {
    n: number
}

interface Cond {
    sql: string;
    values: unknown[]
}

/* ══════════════════════════════════════════════════════════════
   公共：从 URL query 构建 WHERE 子句 + 参数值
   ══════════════════════════════════════════════════════════════ */

function buildWhere(
    tbl: TblMeta,
    params: Record<string, string>,
    userId: number,
    ctx: Ctx,
): { where: string; values: unknown[] } {
    const wp: string[] = [];
    const wv: unknown[] = [];

    /* 1) owner 过滤 */
    if (tbl.hasOwner) {
        wp.push(ownerCond(ctx.n++));
        wv.push(userId);
    }

    /* 2) 普通字段条件（多个字段之间 AND） */
    for (const [key, val] of Object.entries(params)) {
        if (RESERVED.has(key) || !tbl.colMap.has(key)) continue;
        const c = fieldCond(key, val, tbl, ctx);
        wp.push(c.sql);
        wv.push(...c.values);
    }

    /* 3) or=… / and=… 逻辑组合 */
    if (params.or) {
        const c = group("OR", params.or, tbl, ctx);
        wp.push(c.sql);
        wv.push(...c.values);
    }
    if (params.and) {
        const c = group("AND", params.and, tbl, ctx);
        wp.push(c.sql);
        wv.push(...c.values);
    }

    const where = wp.length ? `WHERE ${wp.join(" AND ")}` : "";
    return {where, values: wv};
}

/* ══════════════════════════════════════════════════════════════
   主入口：从 URL query 构建完整 SELECT SQL + COUNT SQL
   ══════════════════════════════════════════════════════════════ */

export function buildListSQL(
    tbl: TblMeta,
    params: Record<string, string>,
    userId: number,
): ListSQL {
    const ctx: Ctx = {n: 1};
    const {where, values: wv} = buildWhere(tbl, params, userId, ctx);

    /* SELECT */
    const sel = buildSel(params.select, tbl);

    /* GROUP BY */
    const grp = params.group
        ? `GROUP BY ${params.group.split(",").map((s) => q(s.trim())).join(", ")}`
        : "";

    /* ORDER BY */
    const ord = params.order ? `ORDER BY ${buildOrd(params.order)}` : "";

    /* 分页（pageSize 上限 1000） */
    const pageNo = params.pageNo ? Math.max(1, Number(params.pageNo)) : undefined;
    const pageSize = params.pageSize ? Math.min(1000, Math.max(1, Number(params.pageSize))) : undefined;
    const lim =
        pageNo !== undefined && pageSize !== undefined
            ? `LIMIT ${pageSize} OFFSET ${(pageNo - 1) * pageSize}`
            : "";

    /* 拼接 */
    const t = q(tbl.name);
    const sql = [`SELECT ${sel} FROM ${t}`, where, grp, ord, lim]
        .filter(Boolean)
        .join(" ");

    /* COUNT SQL（有 GROUP BY 时用子查询） */
    const countSql = grp
        ? `SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${t} ${where} ${grp}) AS _sub`
        : `SELECT COUNT(*) AS total FROM ${t} ${where}`;

    return {
        sql,
        countSql,
        values: [...wv],
        countValues: [...wv],
        pageNo,
        pageSize,
    };
}

/* ══════════════════════════════════════════════════════════════
   DELETE SQL：复用 WHERE 构建，支持与 GET 相同的条件语法
   ══════════════════════════════════════════════════════════════ */

export function buildDeleteSQL(
    tbl: TblMeta,
    params: Record<string, string>,
    userId: number,
): DeleteSQL {
    const ctx: Ctx = {n: 1};
    const {where, values} = buildWhere(tbl, params, userId, ctx);
    const sql = `DELETE
                 FROM ${q(tbl.name)} ${where}`;
    return {sql, values: [...values]};
}

/* ══════════════════════════════════════════════════════════════
   单字段条件: field=op.value  或  field=value（默认 eq）
   ══════════════════════════════════════════════════════════════ */

function fieldCond(field: string, raw: string, tbl: TblMeta, ctx: Ctx): Cond {
    const col = tbl.colMap.get(field)!;

    /* in/nin 无 dot 写法: in(…) nin(…) */
    if (/^n?in\(/.test(raw)) {
        const neg = raw.startsWith("n");
        return buildCond(field, neg ? "nin" : "in", raw.slice(neg ? 3 : 2), col, ctx);
    }

    /* 标准: op.value */
    const dot = raw.indexOf(".");
    if (dot === -1) return buildCond(field, "eq", raw, col, ctx);

    const maybeOp = raw.slice(0, dot).toLowerCase();
    if (ALL_OPS.has(maybeOp))
        return buildCond(field, maybeOp, raw.slice(dot + 1), col, ctx);

    /* 不是已知操作符 → 整个值当 eq */
    return buildCond(field, "eq", raw, col, ctx);
}

/* ══════════════════════════════════════════════════════════════
   构建单条件 SQL
   ══════════════════════════════════════════════════════════════ */

function buildCond(
    field: string, op: string, val: string, col: ColMeta, ctx: Ctx,
): Cond {
    const f = q(field);

    /* IS NULL / IS NOT NULL */
    if (op === "is") return {sql: `${f} IS NULL`, values: []};
    if (op === "nis" || op === "ns") return {sql: `${f} IS NOT NULL`, values: []};

    /* LIKE / NOT LIKE  (* → %) */
    if (op === "like" || op === "nlike") {
        const sqlOp = op === "like" ? "LIKE" : "NOT LIKE";
        return {sql: `${f} ${sqlOp} $${ctx.n++}`, values: [val.replace(/\*/g, "%")]};
    }

    /* IN / NOT IN / BETWEEN */
    if (op === "in" || op === "nin") return buildIn(f, op === "nin", val, col, ctx);

    /* 标准比较 eq ne ge gt le lt */
    const sqlOp = OP[op];
    if (!sqlOp) throw new AppError("QUERY_ERROR", `Unknown operator: ${op}`);
    return {sql: `${f} ${sqlOp} $${ctx.n++}`, values: [typed(val, col)]};
}

/* ─── IN / NOT IN / BETWEEN ─── */

function buildIn(
    f: string, neg: boolean, val: string, col: ColMeta, ctx: Ctx,
): Cond {
    let inner = val;
    if (inner.startsWith("(") && inner.endsWith(")")) inner = inner.slice(1, -1);
    const not = neg ? "NOT " : "";

    /* BETWEEN: 12...20 */
    if (inner.includes("...")) {
        const parts = inner.split("...");
        const lo = parts[0];
        const hi = parts[parts.length - 1];
        if (!lo || !hi) throw new AppError("QUERY_ERROR", "BETWEEN requires two values: lo...hi");
        return {
            sql: `${f} ${not}BETWEEN $${ctx.n++} AND $${ctx.n++}`,
            values: [typed(lo, col), typed(hi, col)],
        };
    }

    /* IN (a, b, c) */
    const items = inner.split(",").map((s) => s.trim());
    const ph = items.map(() => `$${ctx.n++}`).join(", ");
    return {sql: `${f} ${not}IN (${ph})`, values: items.map((s) => typed(s, col))};
}

/* ─── 按列类型转换 ─── */
function typed(v: string, col: ColMeta): string | number {
    return col.isNumeric ? Number(v) : v;
}

/* ══════════════════════════════════════════════════════════════
   逻辑分组: or=… / and=…  支持嵌套
   ══════════════════════════════════════════════════════════════ */

function group(logic: "AND" | "OR", raw: string, tbl: TblMeta, ctx: Ctx): Cond {
    const parts = splitTop(raw);
    const conds = parts.map((p) => expr(p, tbl, ctx));
    return {
        sql: `(${conds.map((c) => c.sql).join(` ${logic} `)})`,
        values: conds.flatMap((c) => c.values),
    };
}

/** 解析嵌套表达式（递归） */
function expr(e: string, tbl: TblMeta, ctx: Ctx): Cond {
    /* 嵌套组: or.( … ) / and.( … ) */
    const m = e.match(/^(or|and)\.\((.+)\)$/);
    if (m) return group(m[1]!.toUpperCase() as "AND" | "OR", m[2]!, tbl, ctx);

    /* 简单条件: field.op.value */
    const dot = e.indexOf(".");
    if (dot === -1) throw new AppError("QUERY_ERROR", `Invalid expression: ${e}`);
    const field = e.slice(0, dot);
    if (!tbl.colMap.has(field))
        throw new AppError("QUERY_ERROR", `Unknown column: ${field}`);
    return fieldCond(field, e.slice(dot + 1), tbl, ctx);
}

/** 逗号分割（尊重括号嵌套） */
function splitTop(s: string): string[] {
    const r: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") depth--;
        else if (s[i] === "," && depth === 0) {
            r.push(s.slice(start, i));
            start = i + 1;
        }
    }
    r.push(s.slice(start));
    return r;
}

/* ══════════════════════════════════════════════════════════════
   SELECT 解析:  name  |  age:userAge  |  max:age  |  max:age:maxAge
   ══════════════════════════════════════════════════════════════ */

function buildSel(raw: string | undefined, _tbl: TblMeta): string {
    if (!raw) return "*";
    return raw
        .split(",")
        .map((item) => {
            const p = item.trim().split(":");
            if (p.length === 1) return q(p[0]!);
            if (p.length === 2) {
                /* func:field  或  field:alias */
                if (AGG_FUNCS.has(p[0]!.toLowerCase())) {
                    const fn = p[0]!.toUpperCase();
                    return `${fn}(${q(p[1]!)}) AS ${q(`${p[0]!.toLowerCase()}:${p[1]!}`)}`;
                }
                return `${q(p[0]!)} AS ${q(p[1]!)}`;
            }
            /* func:field:alias */
            return `${p[0]!.toUpperCase()}(${q(p[1]!)}) AS ${q(p[2]!)}`;
        })
        .join(", ");
}

/* ══════════════════════════════════════════════════════════════
   ORDER BY 解析:  asc.age,desc.name  （省略方向默认 ASC）
   ══════════════════════════════════════════════════════════════ */

function buildOrd(raw: string): string {
    return raw
        .split(",")
        .map((s) => {
            const t = s.trim();
            if (t.startsWith("asc.")) return `${q(t.slice(4))} ASC`;
            if (t.startsWith("desc.")) return `${q(t.slice(5))} DESC`;
            return `${q(t)} ASC`;
        })
        .join(", ");
}

/* ══════════════════════════════════════════════════════════════════════════
   ██████  Body 模式（POST JSON）→ SQL
   （类型定义和 Zod Schema 见 types.ts）
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════
   Body 模式入口: 完整 SELECT
   ══════════════════════════════════════════════════════════════ */

export function buildBodyListSQL(
    tbl: TblMeta, body: BodyQuery, userId: number,
): ListSQL {
    const ctx: Ctx = {n: 1};
    const {where, values: wv} = bodyBuildWhere(tbl, body.where, userId, ctx);

    const sel = bodyBuildSel(body.select);
    const grp = body.group?.length
        ? `GROUP BY ${body.group.map((f) => q(f)).join(", ")}`
        : "";
    const ord = body.order?.length
        ? `ORDER BY ${bodyBuildOrd(body.order)}`
        : "";

    const pageNo = body.pageNo ? Math.max(1, body.pageNo) : undefined;
    const pageSize = body.pageSize ? Math.min(1000, Math.max(1, body.pageSize)) : undefined;
    const lim =
        pageNo !== undefined && pageSize !== undefined
            ? `LIMIT ${pageSize} OFFSET ${(pageNo - 1) * pageSize}`
            : "";

    const t = q(tbl.name);
    const sql = [`SELECT ${sel} FROM ${t}`, where, grp, ord, lim]
        .filter(Boolean)
        .join(" ");

    const countSql = grp
        ? `SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${t} ${where} ${grp}) AS _sub`
        : `SELECT COUNT(*) AS total FROM ${t} ${where}`;

    return {
        sql, countSql,
        values: [...wv], countValues: [...wv],
        pageNo, pageSize,
    };
}

/* ══════════════════════════════════════════════════════════════
   Body 模式入口: DELETE
   ══════════════════════════════════════════════════════════════ */

export function buildBodyDeleteSQL(
    tbl: TblMeta, where: BodyWhereInput | undefined, userId: number,
): DeleteSQL {
    const ctx: Ctx = {n: 1};
    const w = bodyBuildWhere(tbl, where, userId, ctx);
    return {
        sql: `DELETE
              FROM ${q(tbl.name)} ${w.where}`, values: [...w.values]
    };
}

/* ══════════════════════════════════════════════════════════════
   Body WHERE → SQL
   ══════════════════════════════════════════════════════════════ */

function bodyBuildWhere(
    tbl: TblMeta, input: BodyWhereInput | undefined, userId: number, ctx: Ctx,
): { where: string; values: unknown[] } {
    const wp: string[] = [];
    const wv: unknown[] = [];

    /* owner 过滤 */
    if (tbl.hasOwner) {
        wp.push(ownerCond(ctx.n++));
        wv.push(userId);
    }

    if (input) {
        const items = normalizeWhereInput(input);
        for (const item of items) {
            const c = bodyCondItem(item, tbl, ctx);
            wp.push(c.sql);
            wv.push(...c.values);
        }
    }

    const where = wp.length ? `WHERE ${wp.join(" AND ")}` : "";
    return {where, values: wv};
}

/**
 * 规范化 where 输入：
 *   - 如果是数组且首元素为 string → 当作单条件元组
 *   - 如果是对象（非数组）→ 包装为单元素数组
 *   - 否则 → 条件数组
 */
function normalizeWhereInput(input: BodyWhereInput): BodyWhereItem[] {
    if (!Array.isArray(input)) return [input as BodyWhereItem];
    if (input.length === 0) return [];
    /* 首元素是 string → 单条件元组 [field, op?, value] */
    if (typeof input[0] === "string") return [input as BodyWhereItem];
    return input as BodyWhereItem[];
}

/** 解析单个 where 条件项 → SQL */
function bodyCondItem(item: BodyWhereItem, tbl: TblMeta, ctx: Ctx): Cond {
    /* 1) 元组格式 */
    if (Array.isArray(item)) {
        if (item.length === 2) {
            const [field, value] = item as [string, unknown];
            return bodyFieldCond(field, "eq", value, tbl, ctx);
        }
        if (item.length === 3) {
            const [field, op, value] = item as [string, string, unknown];
            return bodyFieldCond(field, op, value, tbl, ctx);
        }
        throw new AppError("QUERY_ERROR", "Invalid where tuple, expected 2 or 3 elements");
    }

    /* 2) 逻辑组合: { op: "and"/"or", cond: [...] } */
    if ("cond" in item) {
        const logic = (item.op || "and").toUpperCase() as "AND" | "OR";
        const children = (item.cond || []).map((c) => {
            const items = normalizeWhereInput(c);
            /* 如果子输入规范化后是多条件，包装成 AND 组 */
            if (items.length === 1) return bodyCondItem(items[0]!, tbl, ctx);
            const subs = items.map((i) => bodyCondItem(i, tbl, ctx));
            return {
                sql: `(${subs.map((s) => s.sql).join(" AND ")})`,
                values: subs.flatMap((s) => s.values),
            };
        });
        return {
            sql: `(${children.map((c) => c.sql).join(` ${logic} `)})`,
            values: children.flatMap((c) => c.values),
        };
    }

    /* 3) 对象格式: { field, op, value } */
    return bodyFieldCond(item.field, item.op, item.value, tbl, ctx);
}

/** Body 模式：单字段条件 → SQL */
function bodyFieldCond(
    field: string, op: string, value: unknown, tbl: TblMeta, ctx: Ctx,
): Cond {
    const col = tbl.colMap.get(field);
    if (!col) throw new AppError("QUERY_ERROR", `Unknown column: ${field}`);

    const f = q(field);
    const o = op.toLowerCase();

    /* IS NULL / IS NOT NULL */
    if (o === "is") return {sql: `${f} IS NULL`, values: []};
    if (o === "nis" || o === "ns") return {sql: `${f} IS NOT NULL`, values: []};

    /* LIKE / NOT LIKE */
    if (o === "like" || o === "nlike") {
        const sqlOp = o === "like" ? "LIKE" : "NOT LIKE";
        return {sql: `${f} ${sqlOp} $${ctx.n++}`, values: [String(value)]};
    }

    /* IN / NOT IN */
    if (o === "in" || o === "nin") {
        const arr = Array.isArray(value) ? value : [value];
        const not = o === "nin" ? "NOT " : "";
        const ph = arr.map(() => `$${ctx.n++}`).join(", ");
        return {
            sql: `${f} ${not}IN (${ph})`,
            values: arr.map((v) => col.isNumeric ? Number(v) : v),
        };
    }

    /* BETWEEN */
    if (o === "between" || o === "bt") {
        const arr = Array.isArray(value) ? value : [];
        if (arr.length !== 2)
            throw new AppError("QUERY_ERROR", "between requires [lo, hi] array");
        return {
            sql: `${f} BETWEEN $${ctx.n++} AND $${ctx.n++}`,
            values: arr.map((v) => col.isNumeric ? Number(v) : v),
        };
    }

    /* 标准比较 eq ne ge gt le lt */
    const sqlOp = OP[o];
    if (!sqlOp) throw new AppError("QUERY_ERROR", `Unknown operator: ${op}`);
    const v = col.isNumeric ? Number(value) : value;
    return {sql: `${f} ${sqlOp} $${ctx.n++}`, values: [v]};
}

/* ══════════════════════════════════════════════════════════════
   Body SELECT 解析
   ══════════════════════════════════════════════════════════════ */

function bodyBuildSel(items?: BodySelectItem[]): string {
    if (!items || items.length === 0) return "*";
    return items.map((item) => {
        if (typeof item === "string") {
            /* 复用 URL 解析逻辑（冒号分割） */
            const p = item.split(":");
            if (p.length === 1) return q(p[0]!);
            if (p.length === 2) {
                if (AGG_FUNCS.has(p[0]!.toLowerCase())) {
                    const fn = p[0]!.toUpperCase();
                    return `${fn}(${q(p[1]!)}) AS ${q(`${p[0]!.toLowerCase()}:${p[1]!}`)}`;
                }
                return `${q(p[0]!)} AS ${q(p[1]!)}`;
            }
            return `${p[0]!.toUpperCase()}(${q(p[1]!)}) AS ${q(p[2]!)}`;
        }
        /* 对象格式 { field, alias?, func? } */
        const col = item.func
            ? `${item.func.toUpperCase()}(${q(item.field)})`
            : q(item.field);
        /* func 无 alias 时默认 AS "func:field" */
        if (item.alias) return `${col} AS ${q(item.alias)}`;
        if (item.func) return `${col} AS ${q(`${item.func.toLowerCase()}:${item.field}`)}`;
        return col;
    }).join(", ");
}

/* ══════════════════════════════════════════════════════════════
   Body ORDER BY 解析
   ══════════════════════════════════════════════════════════════ */

function bodyBuildOrd(items: BodyOrderItem[]): string {
    return items.map((item) => {
        if (typeof item === "string") {
            if (item.startsWith("asc.")) return `${q(item.slice(4))} ASC`;
            if (item.startsWith("desc.")) return `${q(item.slice(5))} DESC`;
            return `${q(item)} ASC`;
        }
        return `${q(item.field)} ${(item.dir || "asc").toUpperCase()}`;
    }).join(", ");
}

/* ══════════════════════════════════════════════════════════════
   Body 模式入口: UPDATE（条件批量更新）
   ══════════════════════════════════════════════════════════════ */

export interface UpdateSQL {
    updateSql: string;
    selectSql: string;
    updateValues: unknown[];
    selectValues: unknown[];
}

export function buildBodyUpdateSQL(
    tbl: TblMeta, set: Record<string, unknown>, where: BodyWhereInput, userId: number,
): UpdateSQL {
    /* 校验 where 非空 */
    if (Array.isArray(where) && (where as any[]).length === 0) {
        throw new AppError("QUERY_ERROR", "where condition must not be empty for update");
    }

    /* 1) 构建 SET 子句（占位符从 $1 开始） */
    const setClauses: string[] = [];
    const setVals: unknown[] = [];
    let n = 1;

    for (const [k, v] of Object.entries(set)) {
        if (k === tbl.pk) continue;
        if (k === cfg.ownerField && tbl.hasOwner) continue;
        if (tbl.colMap.has(k)) {
            setClauses.push(`${q(k)} = $${n++}`);
            setVals.push(v);
        }
    }
    if (setClauses.length === 0) {
        throw new AppError("QUERY_ERROR", "No valid columns in set");
    }

    /* 2) 构建 WHERE 子句（UPDATE 版，占位符接续 SET） */
    const updCtx: Ctx = {n};
    const updW = bodyBuildWhere(tbl, where, userId, updCtx);

    /* 3) 构建 WHERE 子句（SELECT 版，占位符从 $1 开始） */
    const selCtx: Ctx = {n: 1};
    const selW = bodyBuildWhere(tbl, where, userId, selCtx);

    if (!updW.where) {
        throw new AppError("QUERY_ERROR", "where condition is required for update");
    }

    const t = q(tbl.name);
    return {
        updateSql: `UPDATE ${t} SET ${setClauses.join(", ")} ${updW.where}`,
        selectSql: `SELECT ${q(tbl.pk!)} FROM ${t} ${selW.where}`,
        updateValues: [...setVals, ...updW.values],
        selectValues: [...selW.values],
    };
}
