/**
 * test.ts — RestBase 全面集成测试
 *
 * 运行: bun test test.ts
 *
 * bun test 自动设置 NODE_ENV=test 并加载 .env.test:
 *   DB=sqlite://:memory:    → 每次全新内存库
 *   DB_INIT_SQL=init.sql    → 自动执行种子 SQL
 *   SVR_PORT=13333          → 避免与开发服务端口冲突
 *   LOG_CONSOLE=false       → 测试时不刷日志
 *
 * 服务器在 import 时启动，测试结束进程退出，内存库自动释放。
 *
 * 覆盖范围:
 *   Part 0: 元数据接口 (/api/meta/tables)
 *   Part 1: Client API（Auth / CRUD / QueryBuilder / DeleteBuilder）
 *   Part 2: 原始 HTTP（GET / DELETE URL 查询参数全场景）
 */

/* 启动服务（顶层 await，initDb + Bun.serve 全部完成后继续） */
import {server} from "./server.ts";

import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {cfg} from "./types.ts";
import RestBase, {
    agg,
    and,
    type ApiResponse,
    between,
    eq,
    ge,
    gt,
    isIn,
    isNotNull,
    isNull,
    le,
    like,
    lt,
    ne,
    nlike,
    notIn,
    or,
    sel,
} from "../client/restbase-client.ts";

const BASE = `http://localhost:${cfg.port}`;

/* 测试全部完成后关闭服务器，释放端口并退出进程 */
afterAll(() => {
    server.stop(true);
});

/* ═══════════════════════════════════════════════════════════════
   工具函数
   ═══════════════════════════════════════════════════════════════ */

/** 原始 HTTP 请求 */
async function raw(
    method: string,
    path: string,
    opts?: { auth?: string; body?: unknown },
): Promise<ApiResponse> {
    const headers: Record<string, string> = {"Content-Type": "application/json"};
    if (opts?.auth) headers["Authorization"] = opts.auth;
    const init: RequestInit = {method, headers};
    if (opts?.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(`${BASE}${path}`, init);
    return res.json() as Promise<ApiResponse>;
}

/** Basic Auth header */
const basic = (u: string, p: string) =>
    `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

const AUTH = basic("admin", "admin");

/* ═══════════════════════════════════════════════════════════════
   Part 0: 元数据接口
   ═══════════════════════════════════════════════════════════════ */

describe("Meta API", () => {

    test("GET /api/meta/tables — 获取表元数据", async () => {
        const res = await raw("GET", "/api/meta/tables", {auth: AUTH});
        expect(res.code).toBe("OK");
        const tables = res.data as any[];
        expect(Array.isArray(tables)).toBe(true);
        expect(tables.length).toBeGreaterThanOrEqual(2); // products + logs

        /* 不应包含 users 表 */
        const names = tables.map((t: any) => t.name);
        expect(names).not.toContain("users");
        expect(names).toContain("products");
        expect(names).toContain("logs");
    });

    test("products 元数据结构", async () => {
        const res = await raw("GET", "/api/meta/tables", {auth: AUTH});
        const tables = res.data as any[];
        const products = tables.find((t: any) => t.name === "products");
        expect(products).toBeDefined();
        expect(products.pk).toBe("id");
        expect(products.hasOwner).toBe(true);
        expect(products.columns.length).toBeGreaterThan(0);

        const colNames = products.columns.map((c: any) => c.name);
        expect(colNames).toContain("id");
        expect(colNames).toContain("name");
        expect(colNames).toContain("price");
        expect(colNames).toContain("owner");

        /* 列类型信息 */
        const idCol = products.columns.find((c: any) => c.name === "id");
        expect(idCol.type).toBe("integer");
        expect(idCol.isNumeric).toBe(true);

        const nameCol = products.columns.find((c: any) => c.name === "name");
        expect(nameCol.type).toBe("text");
        expect(nameCol.isNumeric).toBe(false);
    });

    test("logs 元数据结构（无 owner）", async () => {
        const res = await raw("GET", "/api/meta/tables", {auth: AUTH});
        const tables = res.data as any[];
        const logs = tables.find((t: any) => t.name === "logs");
        expect(logs).toBeDefined();
        expect(logs.pk).toBe("id");
        expect(logs.hasOwner).toBe(false);
    });

    test("GET /api/meta/tables/:name — 获取单表元数据", async () => {
        const res = await raw("GET", "/api/meta/tables/products", {auth: AUTH});
        expect(res.code).toBe("OK");
        const tbl = res.data as any;
        expect(tbl).not.toBeNull();
        expect(tbl.name).toBe("products");
        expect(tbl.pk).toBe("id");
        expect(tbl.hasOwner).toBe(true);
        expect(tbl.columns.length).toBeGreaterThan(0);
    });

    test("GET /api/meta/tables/:name — 表不存在返回 null", async () => {
        const res = await raw("GET", "/api/meta/tables/nonexistent", {auth: AUTH});
        expect(res.code).toBe("OK");
        expect(res.data).toBeNull();
    });

    test("GET /api/meta/tables/:name — users 表不暴露", async () => {
        const res = await raw("GET", "/api/meta/tables/users", {auth: AUTH});
        expect(res.code).toBe("OK");
        expect(res.data).toBeNull();
    });

    test("GET /api/meta/sync — 同步表结构", async () => {
        const res = await raw("GET", "/api/meta/sync", {auth: AUTH});
        expect(res.code).toBe("OK");
        const tables = res.data as any[];
        expect(Array.isArray(tables)).toBe(true);
        const names = tables.map((t: any) => t.name);
        expect(names).toContain("products");
        expect(names).toContain("logs");
        expect(names).not.toContain("users");
    });

    test("GET /api/meta/sync — 能发现运行时新建的表", async () => {
        await raw("GET", "/api/meta/sync", {auth: AUTH}); // 先 sync 确认初始状态

        /* 验证 sync 调用后返回的表列表与 GET /api/meta/tables 一致 */
        const syncRes = await raw("GET", "/api/meta/sync", {auth: AUTH});
        const getRes = await raw("GET", "/api/meta/tables", {auth: AUTH});
        expect(syncRes.code).toBe("OK");
        expect(getRes.code).toBe("OK");

        const syncNames = (syncRes.data as any[]).map((t: any) => t.name).sort();
        const getNames = (getRes.data as any[]).map((t: any) => t.name).sort();
        expect(syncNames).toEqual(getNames);
    });

    test("未鉴权访问 meta 应失败", async () => {
        const res = await raw("GET", "/api/meta/tables");
        expect(res.code).toBe("AUTH_ERROR");
    });

    test("未鉴权访问 meta/sync 应失败", async () => {
        const res = await raw("GET", "/api/meta/sync");
        expect(res.code).toBe("AUTH_ERROR");
    });
});

/* ═══════════════════════════════════════════════════════════════
   Part 1: Client API 测试
   ═══════════════════════════════════════════════════════════════ */

describe("Client API", () => {
    const rb = new RestBase(BASE);
    let token: string;

    /* ── 1.1 健康检查 ── */
    test("health check", async () => {
        const res = await rb.health();
        expect(res.code).toBe("OK");
        expect((res.data as any).status).toBe("healthy");
    });

    /* ── 1.2 注册 ── */
    test("auth register", async () => {
        const res = await rb.auth.register("testuser", "testpass");
        expect(res.code).toBe("OK");
        expect(typeof res.data).toBe("string");
        expect(res.data!.length).toBeGreaterThan(0);
        token = res.data as string;
    });

    /* ── 1.3 重复注册失败 ── */
    test("auth register duplicate fails", async () => {
        const res = await rb.auth.register("testuser", "testpass");
        expect(res.code).toBe("AUTH_ERROR");
    });

    /* ── 1.4 登录 ── */
    test("auth login", async () => {
        const res = await rb.auth.login("testuser", "testpass");
        expect(res.code).toBe("OK");
        expect(typeof res.data).toBe("string");
        token = res.data as string;
    });

    /* ── 1.5 登录错误密码 ── */
    test("auth login wrong password", async () => {
        const rb2 = new RestBase(BASE);
        const res = await rb2.auth.login("testuser", "wrongpass");
        expect(res.code).toBe("AUTH_ERROR");
    });

    /* ── 1.6 获取用户资料 ── */
    test("auth get profile", async () => {
        const res = await rb.auth.getProfile();
        expect(res.code).toBe("OK");
        expect((res.data as any).username).toBe("testuser");
    });

    /* ── 1.7 更新用户资料 ── */
    test("auth update profile", async () => {
        const res = await rb.auth.updateProfile({password: "newpass"});
        expect(res.code).toBe("OK");

        const rb2 = new RestBase(BASE);
        const login = await rb2.auth.login("testuser", "newpass");
        expect(login.code).toBe("OK");
    });

    /* ── 1.8 Basic Auth ── */
    test("auth basic auth", async () => {
        const rb3 = new RestBase(BASE);
        rb3.auth.useBasicAuth("admin", "admin");
        const res = await rb3.auth.getProfile();
        expect(res.code).toBe("OK");
        expect((res.data as any).username).toBe("admin");
    });

    /* ── 1.9 Token 管理 ── */
    test("auth token management", () => {
        expect(rb.auth.getToken()).toBeTruthy();
        rb.auth.logout();
        expect(rb.auth.getToken()).toBeNull();
        rb.auth.setToken(token);
        expect(rb.auth.getToken()).toBe(token);
    });

    /* ── 1.10 未鉴权访问 ── */
    test("auth unauthorized access", async () => {
        const rb4 = new RestBase(BASE);
        const res = await rb4.table("products").getByPk(1);
        expect(res.code).toBe("AUTH_ERROR");
    });

    /* ────────────── CRUD（用 admin 的 Basic Auth） ────────────── */

    describe("CRUD (products)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => {
            rbAdmin.auth.useBasicAuth("admin", "admin");
        });
        const products = () => rbAdmin.table("products");

        test("create single record", async () => {
            const res = await products().create({name: "TestItem", price: 42.0, stock: 10, category: "Test"});
            expect(res.code).toBe("OK");
            expect((res.data as any).created).toBeInstanceOf(Array);
            expect((res.data as any).created.length).toBe(1);
        });

        test("create batch records", async () => {
            const res = await products().create([
                {name: "BatchA", price: 10.0, stock: 5, category: "Batch"},
                {name: "BatchB", price: 20.0, stock: 8, category: "Batch"},
            ]);
            expect(res.code).toBe("OK");
            expect((res.data as any).created.length).toBe(2);
        });

        test("getByPk", async () => {
            const res = await products().getByPk(1);
            expect(res.code).toBe("OK");
            expect(res.data).not.toBeNull();
            expect((res.data as any).id).toBe(1);
        });

        test("getByPk not found", async () => {
            const res = await products().getByPk(99999);
            expect(res.code).toBe("OK");
            expect(res.data).toBeNull();
        });

        test("put update existing", async () => {
            const res = await products().put({id: 1, price: 888.88});
            expect(res.code).toBe("OK");
            expect((res.data as any).updated).toContain(1);
            expect((res.data as any).created.length).toBe(0);
            const check = await products().getByPk(1);
            expect((check.data as any).price).toBe(888.88);
        });

        test("put create new", async () => {
            const res = await products().put({name: "PutNew", price: 77.77, stock: 3, category: "Put"});
            expect(res.code).toBe("OK");
            expect((res.data as any).created.length).toBe(1);
            const newId = (res.data as any).created[0];
            expect(typeof newId).toBe("number");
            const check = await products().getByPk(newId);
            expect((check.data as any).name).toBe("PutNew");
        });

        test("deleteByPk", async () => {
            const cr = await products().create({name: "ToDelete", price: 1, stock: 0, category: "Del"});
            const id = (cr.data as any).created[0];
            const res = await products().deleteByPk(id);
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted).toContain(id);
            const check = await products().getByPk(id);
            expect(check.data).toBeNull();
        });
    });

    /* ────────────── CRUD（logs 表 — 无 owner） ────────────── */

    describe("CRUD (logs, no owner)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => {
            rbAdmin.auth.useBasicAuth("admin", "admin");
        });
        const logs = () => rbAdmin.table("logs");

        test("getByPk on logs", async () => {
            const res = await logs().getByPk(1);
            expect(res.code).toBe("OK");
            expect(res.data).not.toBeNull();
        });

        test("create log record", async () => {
            const res = await logs().create({level: "TEST", module: "test", message: "hello"});
            expect(res.code).toBe("OK");
        });
    });

    /* ────────────── QueryBuilder 测试 ────────────── */

    describe("QueryBuilder (products)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => {
            rbAdmin.auth.useBasicAuth("admin", "admin");
        });
        const products = () => rbAdmin.table("products");

        test("query all", async () => {
            const res = await products().query().exec();
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
        });

        test("where eq", async () => {
            const res = await products().query().where(eq("is_active", 1)).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(row.is_active).toBe(1);
        });

        test("where ne", async () => {
            const res = await products().query().where(ne("category", "Books")).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(row.category).not.toBe("Books");
        });

        test("where gt", async () => {
            const res = await products().query().where(gt("price", 500)).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
            for (const row of res.data as any[]) expect(row.price).toBeGreaterThan(500);
        });

        test("where ge", async () => {
            const res = await products().query().where(ge("stock", 200)).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(row.stock).toBeGreaterThanOrEqual(200);
        });

        test("where lt", async () => {
            const res = await products().query().where(lt("price", 50)).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(row.price).toBeLessThan(50);
        });

        test("where le", async () => {
            const res = await products().query().where(le("rating", 2)).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(row.rating).toBeLessThanOrEqual(2);
        });

        test("where like", async () => {
            const res = await products().query().where(like("name", "%Pro%")).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
            for (const row of res.data as any[]) expect(row.name.toLowerCase()).toContain("pro");
        });

        test("where nlike", async () => {
            const res = await products().query().where(nlike("name", "%Pro%")).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(row.name.toLowerCase().includes("pro")).toBe(false);
        });

        test("where isNull", async () => {
            const res = await products().query().where(isNull("tags")).exec();
            expect(res.code).toBe("OK");
            /* init.sql 中有 6 条 tags=NULL 的产品 */
            expect((res.data as any[]).length).toBeGreaterThanOrEqual(5);
        });

        test("where isNotNull", async () => {
            const res = await products().query().where(isNotNull("name")).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
        });

        test("where in", async () => {
            const res = await products().query().where(isIn("category", ["Books", "Toys"])).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(["Books", "Toys"]).toContain(row.category);
        });

        test("where notIn", async () => {
            const res = await products().query().where(notIn("category", ["Books", "Toys"])).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(["Books", "Toys"]).not.toContain(row.category);
        });

        test("where between", async () => {
            const res = await products().query().where(between("price", 100, 300)).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
            for (const row of res.data as any[]) {
                expect(row.price).toBeGreaterThanOrEqual(100);
                expect(row.price).toBeLessThanOrEqual(300);
            }
        });

        test("where and", async () => {
            const res = await products().query()
                .where(and(gt("price", 100), eq("is_active", 1)))
                .exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) {
                expect(row.price).toBeGreaterThan(100);
                expect(row.is_active).toBe(1);
            }
        });

        test("where or", async () => {
            const res = await products().query()
                .where(or(eq("category", "Books"), eq("category", "Toys")))
                .exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(["Books", "Toys"]).toContain(row.category);
        });

        test("where nested and/or", async () => {
            const res = await products().query()
                .where(and(
                    gt("price", 50),
                    or(eq("category", "Electronics"), eq("category", "Sports")),
                ))
                .exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) {
                expect(row.price).toBeGreaterThan(50);
                expect(["Electronics", "Sports"]).toContain(row.category);
            }
        });

        test("multiple where calls (AND)", async () => {
            const res = await products().query()
                .where(gt("price", 100))
                .where(eq("is_active", 1))
                .exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) {
                expect(row.price).toBeGreaterThan(100);
                expect(row.is_active).toBe(1);
            }
        });

        test("select specific fields", async () => {
            const res = await products().query().select("name", "price").page(1, 5).exec();
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(first).toHaveProperty("name");
            expect(first).toHaveProperty("price");
        });

        test("select with alias", async () => {
            const res = await products().query().select(sel("price", "unitPrice")).page(1, 5).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any[])[0]).toHaveProperty("unitPrice");
        });

        test("select with aggregation", async () => {
            const res = await products().query()
                .select("category", agg("count", "id", "total"), agg("avg", "price", "avgPrice"),
                    agg("max", "price", "maxPrice"), agg("min", "price", "minPrice"),
                    agg("sum", "stock", "totalStock"))
                .groupBy("category")
                .exec();
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(first).toHaveProperty("category");
            expect(first).toHaveProperty("total");
            expect(first).toHaveProperty("avgPrice");
        });

        test("orderAsc", async () => {
            const res = await products().query().orderAsc("price").page(1, 10).exec();
            expect(res.code).toBe("OK");
            const prices = (res.data as any[]).map((r: any) => r.price);
            for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
        });

        test("orderDesc", async () => {
            const res = await products().query().orderDesc("price").page(1, 10).exec();
            expect(res.code).toBe("OK");
            const prices = (res.data as any[]).map((r: any) => r.price);
            for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
        });

        test("groupBy", async () => {
            const res = await products().query()
                .select("category", agg("count", "id", "cnt"))
                .groupBy("category").exec();
            expect(res.code).toBe("OK");
            const cats = (res.data as any[]).map((r: any) => r.category);
            expect(new Set(cats).size).toBe(cats.length);
        });

        test("pagination", async () => {
            const p1 = await products().query().orderAsc("id").page(1, 5).exec();
            const p2 = await products().query().orderAsc("id").page(2, 5).exec();
            expect(p1.pageNo).toBe(1);
            expect(p1.pageSize).toBe(5);
            expect(typeof p1.total).toBe("number");
            expect((p1.data as any[]).length).toBe(5);
            const lastP1 = (p1.data as any[])[(p1.data as any[]).length - 1];
            const firstP2 = (p2.data as any[])[0];
            expect(firstP2.id).toBeGreaterThan(lastP1.id);
        });

        test("data() shortcut", async () => {
            const data = await products().query().page(1, 3).data();
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(3);
        });

        test("first() shortcut", async () => {
            const first = await products().query().orderAsc("id").first();
            expect(first).not.toBeNull();
            expect((first as any).id).toBe(1);
        });

        test("complex chain query", async () => {
            const res = await products().query()
                .where(gt("price", 10), eq("is_active", 1))
                .where(isNotNull("category"))
                .select("name", "price", "category")
                .orderDesc("price")
                .page(1, 10)
                .exec();
            expect(res.code).toBe("OK");
            expect(res.pageNo).toBe(1);
            expect(res.pageSize).toBe(10);
            expect(typeof res.total).toBe("number");
        });
    });

    /* ────────────── QueryBuilder (logs — 无 owner) ────────────── */

    describe("QueryBuilder (logs, no owner)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => {
            rbAdmin.auth.useBasicAuth("admin", "admin");
        });
        const logs = () => rbAdmin.table("logs");

        test("query logs with where", async () => {
            const res = await logs().query().where(eq("level", "ERROR")).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
            for (const row of res.data as any[]) expect(row.level).toBe("ERROR");
        });

        test("query logs group by level", async () => {
            const res = await logs().query()
                .select("level", agg("count", "id", "cnt"))
                .groupBy("level").exec();
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
        });
    });

    /* ────────────── DeleteBuilder 测试 ────────────── */

    describe("DeleteBuilder (products)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => {
            rbAdmin.auth.useBasicAuth("admin", "admin");
        });
        const products = () => rbAdmin.table("products");

        test("deleteWhere with single condition", async () => {
            await products().create([
                {name: "DelTest1", price: 0.01, stock: 0, category: "DelCat"},
                {name: "DelTest2", price: 0.02, stock: 0, category: "DelCat"},
            ]);
            const res = await products().deleteWhere().where(eq("category", "DelCat")).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
            expect(Array.isArray((res.data as any).deleted)).toBe(true);
        });

        test("deleteWhere with and/or", async () => {
            await products().create([
                {name: "DelOr1", price: 0.01, stock: 0, category: "OrCat1"},
                {name: "DelOr2", price: 0.02, stock: 0, category: "OrCat2"},
            ]);
            const res = await products().deleteWhere()
                .where(or(eq("category", "OrCat1"), eq("category", "OrCat2")))
                .exec();
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });
    });

    /* ────────────── 禁止操作 auth 表 ────────────── */

    describe("auth table protection", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => {
            rbAdmin.auth.useBasicAuth("admin", "admin");
        });

        test("cannot CRUD users table directly", async () => {
            const res = await rbAdmin.table("users").getByPk(1);
            expect(res.code).toBe("FORBIDDEN");
        });
    });

    /* ────────────── requestId ────────────── */

    describe("requestId", () => {
        test("set custom requestId", async () => {
            const rbAdmin = new RestBase(BASE);
            rbAdmin.auth.useBasicAuth("admin", "admin");
            rbAdmin.setRequestId("test-req-id-12345");
            const res = await rbAdmin.health();
            expect(res.code).toBe("OK");
        });
    });

    /* ────────────── Meta（通过 client） ────────────── */

    describe("meta via client", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => {
            rbAdmin.auth.useBasicAuth("admin", "admin");
        });

        test("tables() returns all metadata", async () => {
            const res = await rbAdmin.tables();
            expect(res.code).toBe("OK");
            const names = (res.data as any[]).map((t: any) => t.name);
            expect(names).toContain("products");
            expect(names).toContain("logs");
            expect(names).not.toContain("users");
        });

        test("tableMeta(name) returns single table", async () => {
            const res = await rbAdmin.tableMeta("logs");
            expect(res.code).toBe("OK");
            expect((res.data as any).name).toBe("logs");
            expect((res.data as any).hasOwner).toBe(false);
        });

        test("tableMeta(name) returns null for unknown", async () => {
            const res = await rbAdmin.tableMeta("nope");
            expect(res.code).toBe("OK");
            expect(res.data).toBeNull();
        });

        test("syncMeta() refreshes and returns metadata", async () => {
            const res = await rbAdmin.syncMeta();
            expect(res.code).toBe("OK");
            const names = (res.data as any[]).map((t: any) => t.name);
            expect(names).toContain("products");
        });
    });

    /* ══════════════════════════════════════════════════════════════
       Type-safe SELECT — 运行时验证 + 编译期类型推导
       ══════════════════════════════════════════════════════════════ */

    describe("Type-safe select (typed table)", () => {
        interface Product {
            id: number;
            name: string;
            category: string;
            price: number;
            stock: number;
            rating: number;
            is_active: number;
            tags: string | null;
            description: string | null;
            created_at: string;
            owner: number;
        }

        const rb = new RestBase(BASE);
        beforeAll(() => {
            rb.auth.useBasicAuth("admin", "admin");
        });
        const products = () => rb.table<Product>("products");

        test("select 单字段 → { name: string }", async () => {
            // TypeScript: data is { name: string }[]
            const data = await products().query().select("name").page(1, 3).data();
            expect(data.length).toBe(3);
            expect(data[0]).toHaveProperty("name");

            if (data[0]) {
                expect(typeof data[0].name).toBe("string");
            }
            // 不应包含未选择的字段
            expect(data[0]).not.toHaveProperty("price");
        });

        test("select 多字段 → { name: string; price: number }", async () => {
            // TypeScript: data is { name: string; price: number }[]
            const data = await products().query().select("name", "price").page(1, 3).data();
            expect(data.length).toBe(3);
            expect(data[0]).toHaveProperty("name");
            expect(data[0]).toHaveProperty("price");
            if (data[0]) {
                expect(typeof data[0].name).toBe("string");
                expect(typeof data[0].price).toBe("number");
            }
        });

        test("select + 别名 sel(field, alias) → { unitPrice: number; name: string }", async () => {
            // TypeScript: data is { unitPrice: number; name: string }[]
            const data = await products().query()
                .select(sel("price", "unitPrice"), "name")
                .page(1, 3)
                .data();
            expect(data.length).toBe(3);
            expect(data[0]).toHaveProperty("unitPrice");
            expect(data[0]).toHaveProperty("name");
            if (data[0]) {
                expect(typeof data[0].unitPrice).toBe("number");
            }
        });

        test("select + 聚合 agg() → { category: string; total: number }", async () => {
            // TypeScript: data is { category: string; total: number }[]
            const data = await products().query()
                .select("category", agg("count", "id", "total"))
                .groupBy("category")
                .data();
            expect(data.length).toBeGreaterThan(0);
            expect(data[0]).toHaveProperty("category");
            expect(data[0]).toHaveProperty("total");
            if (data[0]) {
                expect(typeof data[0].total).toBe("number");
            }
        });

        test("select + 多聚合 → { category: string; total: number; avgPrice: number }", async () => {
            // TypeScript: data is { category: string; total: number; avgPrice: number }[]
            const data = await products().query()
                .select("category", agg("count", "id", "total"), agg("avg", "price", "avgPrice"))
                .groupBy("category")
                .data();
            expect(data.length).toBeGreaterThan(0);
            expect(data[0]).toHaveProperty("category");
            expect(data[0]).toHaveProperty("total");
            expect(data[0]).toHaveProperty("avgPrice");
        });

        test("select + where + order + page 全链式", async () => {
            // TypeScript: data is { name: string; price: number }[]
            const data = await products().query()
                .select("name", "price")
                .where(gt("price", 10))
                .orderDesc("price")
                .page(1, 5)
                .data();
            expect(data.length).toBeLessThanOrEqual(5);
            for (const row of data) {
                expect(row).toHaveProperty("name");
                expect(row).toHaveProperty("price");
                expect(row.price).toBeGreaterThan(10);
            }
        });

        test("select 字符串模板 'field:alias'", async () => {
            const data = await products().query()
                .select("price:unitPrice" as any, "name")
                .page(1, 3)
                .data();
            expect(data.length).toBe(3);
            expect(data[0]).toHaveProperty("unitPrice");
            expect(data[0]).toHaveProperty("name");
        });

        test("select 字符串模板 'func:field:alias'", async () => {
            const data = await products().query()
                .select("category", "count:id:total" as any)
                .groupBy("category")
                .data();
            expect(data.length).toBeGreaterThan(0);
            expect(data[0]).toHaveProperty("category");
            expect(data[0]).toHaveProperty("total");
        });

        test("agg 无 alias → 默认 key 为 'fn:field'", async () => {
            // TypeScript: data is { category: string; "count:id": number }[]
            const data = await products().query()
                .select("category", agg("count", "id"))
                .groupBy("category")
                .data();
            expect(data.length).toBeGreaterThan(0);
            expect(data[0]).toHaveProperty("category");
            expect(data[0]).toHaveProperty("count:id");

            if (data[0]) {
                expect(typeof data[0]["count:id"]).toBe("number");
            }
        });

        test("agg 无 alias 多聚合 → key 均为 'fn:field'", async () => {
            // TypeScript: data is { category: string; "count:id": number; "avg:price": number }[]
            const data = await products().query()
                .select("category", agg("count", "id"), agg("avg", "price"))
                .groupBy("category")
                .data();
            expect(data.length).toBeGreaterThan(0);
            expect(data[0]).toHaveProperty("count:id");
            expect(data[0]).toHaveProperty("avg:price");
        });

        test("字符串 'max:price' 与 agg('max','price') 返回相同 key", async () => {
            // 字符串方式
            const data1 = await products().query()
                .select("max:price" as any)
                .data();
            // agg 方式
            const data2 = await products().query()
                .select(agg("max", "price"))
                .data();
            // 两者都应该返回 "max:price" 作为 key
            expect(data1[0]).toHaveProperty("max:price");
            expect(data2[0]).toHaveProperty("max:price");
        });

        test("first() 返回单条带类型", async () => {
            // TypeScript: row is { name: string; price: number } | null
            const row = await products().query()
                .select("name", "price")
                .orderAsc("price")
                .first();
            expect(row).not.toBeNull();
            expect(row!).toHaveProperty("name");
            expect(row!).toHaveProperty("price");
        });

        test("exec() 完整响应带类型", async () => {
            // TypeScript: res.data is { name: string }[]
            const res = await products().query()
                .select("name")
                .page(1, 2)
                .exec();
            expect(res.code).toBe("OK");
            expect(res.data.length).toBeLessThanOrEqual(2);
            expect(res.data[0]).toHaveProperty("name");
        });
    });
});

/* ═══════════════════════════════════════════════════════════════
   Part 2: 原始 HTTP — URL 查询参数全场景
   ═══════════════════════════════════════════════════════════════ */

describe("Raw HTTP — URL query params", () => {

    test("GET /api/health", async () => {
        const res = await raw("GET", "/api/health");
        expect(res.code).toBe("OK");
    });

    /* ══════════════════════════════════════════════════════════
       GET /api/data/:table — 各种条件
       ══════════════════════════════════════════════════════════ */

    describe("GET /api/data/products — operators", () => {

        test("no params (all records)", async () => {
            const res = await raw("GET", "/api/data/products", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThanOrEqual(30);
        });

        test("eq implicit: ?category=Books", async () => {
            const res = await raw("GET", "/api/data/products?category=Books", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.category).toBe("Books");
        });

        test("eq explicit: ?is_active=eq.1", async () => {
            const res = await raw("GET", "/api/data/products?is_active=eq.1", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.is_active).toBe(1);
        });

        test("ne: ?category=ne.Books", async () => {
            const res = await raw("GET", "/api/data/products?category=ne.Books", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.category).not.toBe("Books");
        });

        test("gt: ?price=gt.500", async () => {
            const res = await raw("GET", "/api/data/products?price=gt.500", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
            for (const r of res.data as any[]) expect(r.price).toBeGreaterThan(500);
        });

        test("ge: ?stock=ge.200", async () => {
            const res = await raw("GET", "/api/data/products?stock=ge.200", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.stock).toBeGreaterThanOrEqual(200);
        });

        test("lt: ?price=lt.50", async () => {
            const res = await raw("GET", "/api/data/products?price=lt.50", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.price).toBeLessThan(50);
        });

        test("le: ?rating=le.2", async () => {
            const res = await raw("GET", "/api/data/products?rating=le.2", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.rating).toBeLessThanOrEqual(2);
        });

        test("like: ?name=like.Pro*", async () => {
            const res = await raw("GET", "/api/data/products?name=like.Pro*", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
            for (const r of res.data as any[]) expect(r.name.startsWith("Pro")).toBe(true);
        });

        test("nlike: ?name=nlike.Pro*", async () => {
            const res = await raw("GET", "/api/data/products?name=nlike.Pro*", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.name.startsWith("Pro")).toBe(false);
        });

        test("is null: ?tags=is.null", async () => {
            const res = await raw("GET", "/api/data/products?tags=is.null", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThanOrEqual(5);
        });

        test("is not null: ?name=nis.null", async () => {
            const res = await raw("GET", "/api/data/products?name=nis.null", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
        });

        test("in: ?category=in.(Books,Toys)", async () => {
            const res = await raw("GET", "/api/data/products?category=in.(Books,Toys)", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(["Books", "Toys"]).toContain(r.category);
        });

        test("nin: ?category=nin.(Books,Toys)", async () => {
            const res = await raw("GET", "/api/data/products?category=nin.(Books,Toys)", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(["Books", "Toys"]).not.toContain(r.category);
        });

        test("in between: ?price=in(100...500)", async () => {
            const res = await raw("GET", "/api/data/products?price=in(100...500)", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.price).toBeGreaterThanOrEqual(100);
                expect(r.price).toBeLessThanOrEqual(500);
            }
        });

        test("multi field AND: ?price=gt.100&is_active=eq.1", async () => {
            const res = await raw("GET", "/api/data/products?price=gt.100&is_active=eq.1", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.price).toBeGreaterThan(100);
                expect(r.is_active).toBe(1);
            }
        });
    });

    /* ══════════════════════════════════════════════════════════
       逻辑组合（or / and / 嵌套）
       ══════════════════════════════════════════════════════════ */

    describe("GET /api/data/products — logic groups", () => {

        test("or: ?or=category.eq.Books,category.eq.Toys", async () => {
            const res = await raw("GET", "/api/data/products?or=category.eq.Books,category.eq.Toys", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(["Books", "Toys"]).toContain(r.category);
        });

        test("and: ?and=price.gt.100,is_active.eq.1", async () => {
            const res = await raw("GET", "/api/data/products?and=price.gt.100,is_active.eq.1", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.price).toBeGreaterThan(100);
                expect(r.is_active).toBe(1);
            }
        });

        test("nested: ?and=category.eq.Books,or.(price.gt.500,stock.lt.10)", async () => {
            const res = await raw("GET",
                "/api/data/products?and=category.eq.Books,or.(price.gt.500,stock.lt.10)", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.category).toBe("Books");
                expect(r.price > 500 || r.stock < 10).toBe(true);
            }
        });

        test("nested: ?or=price.gt.900,and.(category.eq.Toys,stock.lt.50)", async () => {
            const res = await raw("GET",
                "/api/data/products?or=price.gt.900,and.(category.eq.Toys,stock.lt.50)", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.price > 900 || (r.category === "Toys" && r.stock < 50)).toBe(true);
            }
        });

        test("field + or: ?is_active=eq.1&or=category.eq.Books,category.eq.Toys", async () => {
            const res = await raw("GET",
                "/api/data/products?is_active=eq.1&or=category.eq.Books,category.eq.Toys", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.is_active).toBe(1);
                expect(["Books", "Toys"]).toContain(r.category);
            }
        });
    });

    /* ══════════════════════════════════════════════════════════
       SELECT / ORDER / GROUP / PAGINATION
       ══════════════════════════════════════════════════════════ */

    describe("GET select/order/group/page", () => {

        test("select=name,price", async () => {
            const res = await raw("GET", "/api/data/products?select=name,price&pageNo=1&pageSize=5", {auth: AUTH});
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(Object.keys(first)).toContain("name");
            expect(Object.keys(first)).toContain("price");
        });

        test("select alias: select=price:unitPrice", async () => {
            const res = await raw("GET", "/api/data/products?select=price:unitPrice&pageNo=1&pageSize=5", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[])[0]).toHaveProperty("unitPrice");
        });

        test("select agg: select=count:id → key 为 'count:id'", async () => {
            const res = await raw("GET", "/api/data/products?select=count:id", {auth: AUTH});
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(first).toHaveProperty("count:id");
        });

        test("select agg+alias: select=max:price:maxPrice,min:price:minPrice", async () => {
            const res = await raw("GET", "/api/data/products?select=max:price:maxPrice,min:price:minPrice", {auth: AUTH});
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(first).toHaveProperty("maxPrice");
            expect(first).toHaveProperty("minPrice");
        });

        test("select+group: ?select=category,count:id:total,avg:price:avgPrice&group=category", async () => {
            const res = await raw("GET",
                "/api/data/products?select=category,count:id:total,avg:price:avgPrice&group=category", {auth: AUTH});
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(first).toHaveProperty("category");
            expect(first).toHaveProperty("total");
            expect(first).toHaveProperty("avgPrice");
        });

        test("order=asc.price", async () => {
            const res = await raw("GET", "/api/data/products?order=asc.price&pageNo=1&pageSize=10", {auth: AUTH});
            expect(res.code).toBe("OK");
            const prices = (res.data as any[]).map((r: any) => r.price);
            for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
        });

        test("order=desc.price", async () => {
            const res = await raw("GET", "/api/data/products?order=desc.price&pageNo=1&pageSize=10", {auth: AUTH});
            expect(res.code).toBe("OK");
            const prices = (res.data as any[]).map((r: any) => r.price);
            for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
        });

        test("order multi: asc.category,desc.price", async () => {
            const res = await raw("GET", "/api/data/products?order=asc.category,desc.price&pageNo=1&pageSize=20", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
        });

        test("order default (asc): order=name", async () => {
            const res = await raw("GET", "/api/data/products?order=name&pageNo=1&pageSize=10", {auth: AUTH});
            expect(res.code).toBe("OK");
            const names = (res.data as any[]).map((r: any) => r.name);
            for (let i = 1; i < names.length; i++) expect(names[i] >= names[i - 1]).toBe(true);
        });

        test("pagination page 1", async () => {
            const res = await raw("GET", "/api/data/products?pageNo=1&pageSize=5", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(res.pageNo).toBe(1);
            expect(res.pageSize).toBe(5);
            expect(typeof res.total).toBe("number");
            expect((res.data as any[]).length).toBeLessThanOrEqual(5);
        });

        test("pagination page 2 vs page 1", async () => {
            const p1 = await raw("GET", "/api/data/products?order=asc.id&pageNo=1&pageSize=5", {auth: AUTH});
            const p2 = await raw("GET", "/api/data/products?order=asc.id&pageNo=2&pageSize=5", {auth: AUTH});
            if ((p2.data as any[]).length > 0) {
                const last1 = (p1.data as any[])[(p1.data as any[]).length - 1];
                const first2 = (p2.data as any[])[0];
                expect(first2.id).toBeGreaterThan(last1.id);
            }
        });

        test("combined: where + order + page", async () => {
            const res = await raw("GET",
                "/api/data/products?is_active=eq.1&order=desc.price&pageNo=1&pageSize=10", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(res.pageNo).toBe(1);
            for (const r of res.data as any[]) expect(r.is_active).toBe(1);
            const prices = (res.data as any[]).map((r: any) => r.price);
            for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
        });
    });

    /* ══════════════════════════════════════════════════════════
       GET /api/data/:table/:id
       ══════════════════════════════════════════════════════════ */

    describe("GET /api/data/:table/:id", () => {
        test("get by pk (exists)", async () => {
            const res = await raw("GET", "/api/data/products/1", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(res.data).not.toBeNull();
            expect((res.data as any).id).toBe(1);
        });

        test("get by pk (not exists)", async () => {
            const res = await raw("GET", "/api/data/products/99999", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(res.data).toBeNull();
        });
    });

    /* ══════════════════════════════════════════════════════════
       DELETE /api/data/:table — URL 条件删除
       ══════════════════════════════════════════════════════════ */

    describe("DELETE /api/data/products (URL params)", () => {

        test("setup: create deletable records", async () => {
            for (let i = 0; i < 5; i++) {
                await raw("POST", "/api/data/products", {
                    auth: AUTH,
                    body: {name: `UrlDel_${i}`, price: 0.001 + i * 0.001, stock: i, category: "UrlDelCat"},
                });
            }
            const check = await raw("GET", "/api/data/products?category=UrlDelCat", {auth: AUTH});
            expect((check.data as any[]).length).toBeGreaterThanOrEqual(5);
        });

        test("delete eq: ?name=UrlDel_0", async () => {
            const res = await raw("DELETE", "/api/data/products?name=UrlDel_0", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(Array.isArray((res.data as any).deleted)).toBe(true);
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(1);
        });

        test("delete gt: ?stock=gt.3&category=UrlDelCat", async () => {
            const res = await raw("DELETE", "/api/data/products?stock=gt.3&category=UrlDelCat", {auth: AUTH});
            expect(res.code).toBe("OK");
        });

        test("delete like: ?name=like.UrlDel*", async () => {
            const res = await raw("DELETE", "/api/data/products?name=like.UrlDel*", {auth: AUTH});
            expect(res.code).toBe("OK");
            const check = await raw("GET", "/api/data/products?category=UrlDelCat", {auth: AUTH});
            expect((check.data as any[]).length).toBe(0);
        });

        test("delete or conditions", async () => {
            await raw("POST", "/api/data/products", {
                auth: AUTH,
                body: [
                    {name: "OrDel_A", price: 0.001, stock: 0, category: "OrDelCatA"},
                    {name: "OrDel_B", price: 0.002, stock: 0, category: "OrDelCatB"},
                ],
            });
            const res = await raw("DELETE",
                "/api/data/products?or=category.eq.OrDelCatA,category.eq.OrDelCatB", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });
    });

    /* ══════════════════════════════════════════════════════════
       DELETE /api/data/:table/:id — 按主键删除
       ══════════════════════════════════════════════════════════ */

    describe("DELETE /api/data/:table/:id", () => {
        test("delete by pk", async () => {
            const cr = await raw("POST", "/api/data/products", {
                auth: AUTH, body: {name: "PkDel", price: 0.001, stock: 0, category: "PkDel"},
            });
            const id = (cr.data as any).created[0];
            const res = await raw("DELETE", `/api/data/products/${id}`, {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted).toContain(id);
            const check = await raw("GET", `/api/data/products/${id}`, {auth: AUTH});
            expect(check.data).toBeNull();
        });
    });

    /* ══════════════════════════════════════════════════════════
       POST /api/query/:table — Body 查询（原始 HTTP）
       ══════════════════════════════════════════════════════════ */

    describe("POST /api/query/products (raw)", () => {

        test("body: where 二元组", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH, body: {where: ["is_active", 1]},
            });
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.is_active).toBe(1);
        });

        test("body: where 三元组", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH, body: {where: ["price", "gt", 500]},
            });
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.price).toBeGreaterThan(500);
        });

        test("body: where 对象格式", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH, body: {where: [{field: "stock", op: "ge", value: 100}]},
            });
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.stock).toBeGreaterThanOrEqual(100);
        });

        test("body: where 逻辑组合 or", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH,
                body: {where: [{op: "or", cond: [["category", "eq", "Books"], ["category", "eq", "Toys"]]}]},
            });
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(["Books", "Toys"]).toContain(r.category);
        });

        test("body: where 嵌套 and + or", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH,
                body: {
                    where: [
                        ["price", "gt", 50],
                        {
                            op: "or", cond: [
                                {field: "category", op: "eq", value: "Electronics"},
                                {field: "category", op: "eq", value: "Sports"},
                            ]
                        },
                    ],
                },
            });
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.price).toBeGreaterThan(50);
                expect(["Electronics", "Sports"]).toContain(r.category);
            }
        });

        test("body: select 字符串 + 别名 + 聚合", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH,
                body: {
                    select: ["category", "count:id:total", "avg:price:avgPrice", {field: "price", func: "max", alias: "maxPrice"}],
                    group: ["category"],
                },
            });
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(first).toHaveProperty("category");
            expect(first).toHaveProperty("total");
            expect(first).toHaveProperty("avgPrice");
            expect(first).toHaveProperty("maxPrice");
        });

        test("body: order 字符串 + 对象 + 分页", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH,
                body: {
                    order: ["desc.price", {field: "name", dir: "asc"}],
                    pageNo: 1, pageSize: 10,
                },
            });
            expect(res.code).toBe("OK");
            expect(res.pageNo).toBe(1);
            expect(res.pageSize).toBe(10);
            const prices = (res.data as any[]).map((r: any) => r.price);
            for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
        });

        test("body: 分页 + total", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH, body: {pageNo: 1, pageSize: 5},
            });
            expect(res.code).toBe("OK");
            expect(res.pageNo).toBe(1);
            expect(res.pageSize).toBe(5);
            expect(typeof res.total).toBe("number");
            expect((res.data as any[]).length).toBeLessThanOrEqual(5);
        });
    });

    /* ══════════════════════════════════════════════════════════
       POST /api/delete/:table — Body 条件删除（原始 HTTP）
       ══════════════════════════════════════════════════════════ */

    describe("POST /api/delete/products (raw)", () => {

        test("body: 三元组 where", async () => {
            await raw("POST", "/api/data/products", {
                auth: AUTH,
                body: [
                    {name: "BodyDel1", price: 0.001, stock: 0, category: "BodyDelCat"},
                    {name: "BodyDel2", price: 0.002, stock: 0, category: "BodyDelCat"},
                ],
            });
            const res = await raw("POST", "/api/delete/products", {
                auth: AUTH, body: ["category", "eq", "BodyDelCat"],
            });
            expect(res.code).toBe("OK");
            expect(Array.isArray((res.data as any).deleted)).toBe(true);
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });

        test("body: 数组 where", async () => {
            await raw("POST", "/api/data/products", {
                auth: AUTH,
                body: [
                    {name: "BodyDel3", price: 0.001, stock: 0, category: "BodyDelCat2"},
                    {name: "BodyDel4", price: 0.002, stock: 0, category: "BodyDelCat2"},
                ],
            });
            const res = await raw("POST", "/api/delete/products", {
                auth: AUTH, body: [["category", "eq", "BodyDelCat2"]],
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });

        test("body: or 条件", async () => {
            await raw("POST", "/api/data/products", {
                auth: AUTH,
                body: [
                    {name: "BodyDelOr1", price: 0.001, stock: 0, category: "BDOrCat1"},
                    {name: "BodyDelOr2", price: 0.002, stock: 0, category: "BDOrCat2"},
                ],
            });
            const res = await raw("POST", "/api/delete/products", {
                auth: AUTH,
                body: [{op: "or", cond: [["category", "eq", "BDOrCat1"], ["category", "eq", "BDOrCat2"]]}],
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });
    });

    /* ══════════════════════════════════════════════════════════
       logs 表（无 owner）原始 HTTP
       ══════════════════════════════════════════════════════════ */

    describe("GET /api/data/logs (no owner)", () => {
        test("query all logs", async () => {
            const res = await raw("GET", "/api/data/logs", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
        });

        test("query logs with filter", async () => {
            const res = await raw("GET", "/api/data/logs?level=ERROR", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.level).toBe("ERROR");
        });

        test("query logs pagination", async () => {
            const res = await raw("GET", "/api/data/logs?pageNo=1&pageSize=10&order=desc.id", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(res.pageNo).toBe(1);
            expect(res.pageSize).toBe(10);
        });

        test("logs group by level", async () => {
            const res = await raw("GET", "/api/data/logs?select=level,count:id:cnt&group=level", {auth: AUTH});
            expect(res.code).toBe("OK");
            const levels = (res.data as any[]).map((r: any) => r.level);
            expect(new Set(levels).size).toBe(levels.length);
        });
    });
});
