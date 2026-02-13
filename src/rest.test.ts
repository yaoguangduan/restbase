/**
 * rest.test.ts — RestBase 全面集成测试
 *
 * 运行: bun test rest.test.ts
 *
 * 覆盖范围:
 *   Part 0: 元数据接口 (/api/meta/tables)
 *   Part 1: Client API（Auth / Save / Query / Delete / Update）
 *   Part 2: 原始 HTTP（URL 查询参数 / Body 全场景）
 */

import {server} from "./server.ts";
import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {cfg} from "./types.ts";
import RestBase, {
    agg, and, type ApiResponse, between, eq, ge, gt,
    isIn, isNotNull, isNull, le, like, lt, ne, nlike, notIn, or, sel,
} from "../client/restbase-client.ts";

const BASE = `http://localhost:${cfg.port}`;

afterAll(() => {
    server.stop(true);
});

/* ═══════════ 工具函数 ═══════════ */

async function raw(
    method: string, path: string,
    opts?: { auth?: string; body?: unknown },
): Promise<ApiResponse> {
    const headers: Record<string, string> = {"Content-Type": "application/json"};
    if (opts?.auth) headers["Authorization"] = opts.auth;
    const init: RequestInit = {method, headers};
    if (opts?.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(`${BASE}${path}`, init);
    return res.json() as Promise<ApiResponse>;
}

const basic = (u: string, p: string) =>
    `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const AUTH = basic("admin", "admin");

/* ═══════════ Part 0: 元数据接口 ═══════════ */

describe("Meta API", () => {
    test("GET /api/meta/tables", async () => {
        const res = await raw("GET", "/api/meta/tables", {auth: AUTH});
        expect(res.code).toBe("OK");
        const tables = res.data as any[];
        expect(Array.isArray(tables)).toBe(true);
        expect(tables.length).toBeGreaterThanOrEqual(2);
        const names = tables.map((t: any) => t.name);
        expect(names).not.toContain("users");
        expect(names).toContain("products");
        expect(names).toContain("logs");
    });

    test("products 元数据结构", async () => {
        const res = await raw("GET", "/api/meta/tables", {auth: AUTH});
        const products = (res.data as any[]).find((t: any) => t.name === "products");
        expect(products).toBeDefined();
        expect(products.pk).toBe("id");
        expect(products.hasOwner).toBe(true);
    });

    test("logs 元数据（无 owner）", async () => {
        const res = await raw("GET", "/api/meta/tables", {auth: AUTH});
        const logs = (res.data as any[]).find((t: any) => t.name === "logs");
        expect(logs).toBeDefined();
        expect(logs.hasOwner).toBe(false);
    });

    test("GET /api/meta/tables/:name", async () => {
        const res = await raw("GET", "/api/meta/tables/products", {auth: AUTH});
        expect(res.code).toBe("OK");
        expect((res.data as any).name).toBe("products");
    });

    test("GET /api/meta/tables/:name — 不存在返回 null", async () => {
        const res = await raw("GET", "/api/meta/tables/nonexistent", {auth: AUTH});
        expect(res.code).toBe("OK");
        expect(res.data).toBeNull();
    });

    test("GET /api/meta/sync", async () => {
        const res = await raw("GET", "/api/meta/sync", {auth: AUTH});
        expect(res.code).toBe("OK");
        const names = (res.data as any[]).map((t: any) => t.name);
        expect(names).toContain("products");
    });

    test("未鉴权访问 meta 应失败", async () => {
        const res = await raw("GET", "/api/meta/tables");
        expect(res.code).toBe("AUTH_ERROR");
    });
});

/* ═══════════ Part 1: Client API ═══════════ */

describe("Client API", () => {
    const rb = new RestBase(BASE);
    let token: string;

    /* ── Auth ── */
    test("health check", async () => {
        const res = await rb.health();
        expect(res.code).toBe("OK");
        expect((res.data as any).status).toBe("healthy");
    });

    test("auth register", async () => {
        const res = await rb.auth.register("testuser", "testpass");
        expect(res.code).toBe("OK");
        token = res.data as string;
    });

    test("auth register duplicate fails", async () => {
        const res = await rb.auth.register("testuser", "testpass");
        expect(res.code).toBe("AUTH_ERROR");
    });

    test("auth login", async () => {
        const res = await rb.auth.login("testuser", "testpass");
        expect(res.code).toBe("OK");
        token = res.data as string;
    });

    test("auth login wrong password", async () => {
        const rb2 = new RestBase(BASE);
        const res = await rb2.auth.login("testuser", "wrongpass");
        expect(res.code).toBe("AUTH_ERROR");
    });

    test("auth profile", async () => {
        const res = await rb.auth.getProfile();
        expect(res.code).toBe("OK");
        expect((res.data as any).username).toBe("testuser");
    });

    test("auth update profile", async () => {
        const res = await rb.auth.updateProfile({password: "newpass"});
        expect(res.code).toBe("OK");
        const rb2 = new RestBase(BASE);
        const login = await rb2.auth.login("testuser", "newpass");
        expect(login.code).toBe("OK");
    });

    test("auth basic auth", async () => {
        const rb3 = new RestBase(BASE);
        rb3.auth.useBasicAuth("admin", "admin");
        const res = await rb3.auth.getProfile();
        expect(res.code).toBe("OK");
        expect((res.data as any).username).toBe("admin");
    });

    test("auth token management", () => {
        expect(rb.auth.getToken()).toBeTruthy();
        rb.auth.logout();
        expect(rb.auth.getToken()).toBeNull();
        rb.auth.setToken(token);
        expect(rb.auth.getToken()).toBe(token);
    });

    test("auth unauthorized access", async () => {
        const rb4 = new RestBase(BASE);
        const res = await rb4.table("products").get(1);
        expect(res.code).toBe("AUTH_ERROR");
    });

    /* ── Save (POST/PUT/PATCH) ── */

    describe("Save (products)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => rbAdmin.auth.useBasicAuth("admin", "admin"));
        const products = () => rbAdmin.table("products");

        test("insert — single", async () => {
            const res = await products().insert({name: "TestItem", price: 42.0, stock: 10, category: "Test"});
            expect(res.code).toBe("OK");
            expect((res.data as any).created).toBeInstanceOf(Array);
            expect((res.data as any).created.length).toBe(1);
        });

        test("insert — batch", async () => {
            const res = await products().insert([
                {name: "BatchA", price: 10.0, stock: 5, category: "Batch"},
                {name: "BatchB", price: 20.0, stock: 8, category: "Batch"},
            ]);
            expect(res.code).toBe("OK");
            expect((res.data as any).created.length).toBe(2);
        });

        test("insert — conflict on existing PK", async () => {
            const res = await products().insert({id: 1, name: "Conflict", price: 1});
            expect(res.code).toBe("CONFLICT");
        });

        test("get (by PK)", async () => {
            const res = await products().get(1);
            expect(res.code).toBe("OK");
            expect(res.data).not.toBeNull();
            expect((res.data as any).id).toBe(1);
        });

        test("get — not found", async () => {
            const res = await products().get(99999);
            expect(res.code).toBe("OK");
            expect(res.data).toBeNull();
        });

        test("upsert — update existing", async () => {
            const res = await products().upsert({id: 1, price: 888.88});
            expect(res.code).toBe("OK");
            expect((res.data as any).updated).toContain(1);
            expect((res.data as any).created.length).toBe(0);
            const check = await products().get(1);
            expect((check.data as any).price).toBe(888.88);
        });

        test("upsert — create new", async () => {
            const res = await products().upsert({name: "PutNew", price: 77.77, stock: 3, category: "Put"});
            expect(res.code).toBe("OK");
            expect((res.data as any).created.length).toBe(1);
            const newId = (res.data as any).created[0];
            const check = await products().get(newId);
            expect((check.data as any).name).toBe("PutNew");
        });

        test("update — existing", async () => {
            const res = await products().update({id: 1, price: 999.99});
            expect(res.code).toBe("OK");
            expect((res.data as any).updated).toContain(1);
            const check = await products().get(1);
            expect((check.data as any).price).toBe(999.99);
        });

        test("update — not found", async () => {
            const res = await products().update({id: 99999, price: 1});
            expect(res.code).toBe("NOT_FOUND");
        });

        test("update — missing PK", async () => {
            const res = await products().update({price: 1});
            expect(res.code).toBe("VALIDATION_ERROR");
        });

        test("update — batch", async () => {
            const res = await products().update([
                {id: 1, stock: 111},
                {id: 2, stock: 222},
            ]);
            expect(res.code).toBe("OK");
            expect((res.data as any).updated.length).toBe(2);
            const c1 = await products().get(1);
            expect((c1.data as any).stock).toBe(111);
            const c2 = await products().get(2);
            expect((c2.data as any).stock).toBe(222);
        });

        test("delete (by PK)", async () => {
            const cr = await products().insert({name: "ToDelete", price: 1, stock: 0, category: "Del"});
            const id = (cr.data as any).created[0];
            const res = await products().delete(id);
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted).toContain(id);
            const check = await products().get(id);
            expect(check.data).toBeNull();
        });
    });

    /* ── Save (logs, no owner) ── */

    describe("Save (logs, no owner)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => rbAdmin.auth.useBasicAuth("admin", "admin"));
        const logs = () => rbAdmin.table("logs");

        test("get on logs", async () => {
            const res = await logs().get(1);
            expect(res.code).toBe("OK");
            expect(res.data).not.toBeNull();
        });

        test("insert log record", async () => {
            const res = await logs().insert({level: "TEST", module: "test", message: "hello"});
            expect(res.code).toBe("OK");
        });
    });

    /* ── QueryBuilder ── */

    describe("QueryBuilder (products)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => rbAdmin.auth.useBasicAuth("admin", "admin"));
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
        });

        test("where nlike", async () => {
            const res = await products().query().where(nlike("name", "%Pro%")).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(row.name.toLowerCase().includes("pro")).toBe(false);
        });

        test("where isNull", async () => {
            const res = await products().query().where(isNull("tags")).exec();
            expect(res.code).toBe("OK");
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
                .where(and(gt("price", 100), eq("is_active", 1))).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) {
                expect(row.price).toBeGreaterThan(100);
                expect(row.is_active).toBe(1);
            }
        });

        test("where or", async () => {
            const res = await products().query()
                .where(or(eq("category", "Books"), eq("category", "Toys"))).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) expect(["Books", "Toys"]).toContain(row.category);
        });

        test("where nested and/or", async () => {
            const res = await products().query()
                .where(and(
                    gt("price", 50),
                    or(eq("category", "Electronics"), eq("category", "Sports")),
                )).exec();
            expect(res.code).toBe("OK");
            for (const row of res.data as any[]) {
                expect(row.price).toBeGreaterThan(50);
                expect(["Electronics", "Sports"]).toContain(row.category);
            }
        });

        test("select + aggregation + group", async () => {
            const res = await products().query()
                .select("category", agg("count", "id", "total"), agg("avg", "price", "avgPrice"))
                .groupBy("category").exec();
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(first).toHaveProperty("category");
            expect(first).toHaveProperty("total");
            expect(first).toHaveProperty("avgPrice");
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
    });

    /* ── DeleteBuilder ── */

    describe("DeleteBuilder (products)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => rbAdmin.auth.useBasicAuth("admin", "admin"));
        const products = () => rbAdmin.table("products");

        test("deleteWhere with condition", async () => {
            await products().insert([
                {name: "DelTest1", price: 0.01, stock: 0, category: "DelCat"},
                {name: "DelTest2", price: 0.02, stock: 0, category: "DelCat"},
            ]);
            const res = await products().deleteWhere().where(eq("category", "DelCat")).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });

        test("deleteWhere with and/or", async () => {
            await products().insert([
                {name: "DelOr1", price: 0.01, stock: 0, category: "OrCat1"},
                {name: "DelOr2", price: 0.02, stock: 0, category: "OrCat2"},
            ]);
            const res = await products().deleteWhere()
                .where(or(eq("category", "OrCat1"), eq("category", "OrCat2"))).exec();
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });
    });

    /* ── UpdateBuilder ── */

    describe("UpdateBuilder (products)", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => rbAdmin.auth.useBasicAuth("admin", "admin"));
        const products = () => rbAdmin.table("products");

        test("updateWhere — single condition", async () => {
            await products().insert([
                {name: "UpdTest1", price: 10, stock: 5, category: "UpdCat"},
                {name: "UpdTest2", price: 20, stock: 8, category: "UpdCat"},
            ]);
            const res = await products().updateWhere()
                .set({price: 99.99})
                .where(eq("category", "UpdCat"))
                .exec();
            expect(res.code).toBe("OK");
            expect((res.data as any).updated.length).toBeGreaterThanOrEqual(2);

            /* 验证更新结果 */
            const check = await products().query().where(eq("category", "UpdCat")).data();
            for (const row of check as any[]) {
                expect(row.price).toBe(99.99);
            }
        });

        test("updateWhere — multiple set fields", async () => {
            const res = await products().updateWhere()
                .set({price: 11.11, stock: 111})
                .where(eq("category", "UpdCat"))
                .exec();
            expect(res.code).toBe("OK");
            const check = await products().query().where(eq("category", "UpdCat")).data();
            for (const row of check as any[]) {
                expect(row.price).toBe(11.11);
                expect(row.stock).toBe(111);
            }
        });

        test("updateWhere — cleanup", async () => {
            await products().deleteWhere().where(eq("category", "UpdCat")).exec();
        });
    });

    /* ── Auth table protection ── */

    describe("auth table protection", () => {
        const rbAdmin = new RestBase(BASE);
        beforeAll(() => rbAdmin.auth.useBasicAuth("admin", "admin"));

        test("cannot query users table", async () => {
            const res = await rbAdmin.table("users").get(1);
            expect(res.code).toBe("FORBIDDEN");
        });
    });

    /* ── Type-safe SELECT ── */

    describe("Type-safe select", () => {
        interface Product {
            id: number; name: string; category: string; price: number;
            stock: number; rating: number; is_active: number;
            tags: string | null; description: string | null;
            created_at: string; owner: number;
        }
        const rb = new RestBase(BASE);
        beforeAll(() => rb.auth.useBasicAuth("admin", "admin"));
        const products = () => rb.table<Product>("products");

        test("select single field", async () => {
            const data = await products().query().select("name").page(1, 3).data();
            expect(data.length).toBe(3);
            expect(data[0]).toHaveProperty("name");
            expect(data[0]).not.toHaveProperty("price");
        });

        test("select multiple fields", async () => {
            const data = await products().query().select("name", "price").page(1, 3).data();
            expect(data[0]).toHaveProperty("name");
            expect(data[0]).toHaveProperty("price");
        });

        test("select + alias", async () => {
            const data = await products().query()
                .select(sel("price", "unitPrice"), "name").page(1, 3).data();
            expect(data[0]).toHaveProperty("unitPrice");
            expect(data[0]).toHaveProperty("name");
        });

        test("select + aggregation", async () => {
            const data = await products().query()
                .select("category", agg("count", "id", "total"))
                .groupBy("category").data();
            expect(data.length).toBeGreaterThan(0);
            expect(data[0]).toHaveProperty("category");
            expect(data[0]).toHaveProperty("total");
        });

        test("agg without alias", async () => {
            const data = await products().query()
                .select("category", agg("count", "id"))
                .groupBy("category").data();
            expect(data[0]).toHaveProperty("count:id");
        });
    });
});

/* ═══════════ Part 2: 原始 HTTP ═══════════ */

describe("Raw HTTP", () => {

    test("GET /api/health", async () => {
        const res = await raw("GET", "/api/health");
        expect(res.code).toBe("OK");
    });

    /* ── GET /api/query/:table — URL 参数查询 ── */

    describe("GET /api/query/products — operators", () => {

        test("no params (all records)", async () => {
            const res = await raw("GET", "/api/query/products", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThanOrEqual(30);
        });

        test("eq implicit: ?category=Books", async () => {
            const res = await raw("GET", "/api/query/products?category=Books", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.category).toBe("Books");
        });

        test("eq explicit: ?is_active=eq.1", async () => {
            const res = await raw("GET", "/api/query/products?is_active=eq.1", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.is_active).toBe(1);
        });

        test("ne: ?category=ne.Books", async () => {
            const res = await raw("GET", "/api/query/products?category=ne.Books", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.category).not.toBe("Books");
        });

        test("gt: ?price=gt.500", async () => {
            const res = await raw("GET", "/api/query/products?price=gt.500", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.price).toBeGreaterThan(500);
        });

        test("ge: ?stock=ge.200", async () => {
            const res = await raw("GET", "/api/query/products?stock=ge.200", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.stock).toBeGreaterThanOrEqual(200);
        });

        test("lt: ?price=lt.50", async () => {
            const res = await raw("GET", "/api/query/products?price=lt.50", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.price).toBeLessThan(50);
        });

        test("le: ?rating=le.2", async () => {
            const res = await raw("GET", "/api/query/products?rating=le.2", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.rating).toBeLessThanOrEqual(2);
        });

        test("like: ?name=like.Pro*", async () => {
            const res = await raw("GET", "/api/query/products?name=like.Pro*", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
        });

        test("is null: ?tags=is.null", async () => {
            const res = await raw("GET", "/api/query/products?tags=is.null", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThanOrEqual(5);
        });

        test("in: ?category=in.(Books,Toys)", async () => {
            const res = await raw("GET", "/api/query/products?category=in.(Books,Toys)", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(["Books", "Toys"]).toContain(r.category);
        });

        test("in between: ?price=in(100...500)", async () => {
            const res = await raw("GET", "/api/query/products?price=in(100...500)", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.price).toBeGreaterThanOrEqual(100);
                expect(r.price).toBeLessThanOrEqual(500);
            }
        });

        test("multi field AND", async () => {
            const res = await raw("GET", "/api/query/products?price=gt.100&is_active=eq.1", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.price).toBeGreaterThan(100);
                expect(r.is_active).toBe(1);
            }
        });
    });

    describe("GET /api/query/products — logic groups", () => {

        test("or", async () => {
            const res = await raw("GET", "/api/query/products?or=category.eq.Books,category.eq.Toys", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(["Books", "Toys"]).toContain(r.category);
        });

        test("and", async () => {
            const res = await raw("GET", "/api/query/products?and=price.gt.100,is_active.eq.1", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.price).toBeGreaterThan(100);
                expect(r.is_active).toBe(1);
            }
        });

        test("nested", async () => {
            const res = await raw("GET",
                "/api/query/products?and=category.eq.Books,or.(price.gt.500,stock.lt.10)", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) {
                expect(r.category).toBe("Books");
                expect(r.price > 500 || r.stock < 10).toBe(true);
            }
        });
    });

    describe("GET select/order/group/page", () => {

        test("select=name,price", async () => {
            const res = await raw("GET", "/api/query/products?select=name,price&pageNo=1&pageSize=5", {auth: AUTH});
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(Object.keys(first)).toContain("name");
            expect(Object.keys(first)).toContain("price");
        });

        test("select alias", async () => {
            const res = await raw("GET", "/api/query/products?select=price:unitPrice&pageNo=1&pageSize=5", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[])[0]).toHaveProperty("unitPrice");
        });

        test("select agg + group", async () => {
            const res = await raw("GET",
                "/api/query/products?select=category,count:id:total,avg:price:avgPrice&group=category", {auth: AUTH});
            expect(res.code).toBe("OK");
            const first = (res.data as any[])[0];
            expect(first).toHaveProperty("category");
            expect(first).toHaveProperty("total");
            expect(first).toHaveProperty("avgPrice");
        });

        test("order=asc.price", async () => {
            const res = await raw("GET", "/api/query/products?order=asc.price&pageNo=1&pageSize=10", {auth: AUTH});
            expect(res.code).toBe("OK");
            const prices = (res.data as any[]).map((r: any) => r.price);
            for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
        });

        test("order=desc.price", async () => {
            const res = await raw("GET", "/api/query/products?order=desc.price&pageNo=1&pageSize=10", {auth: AUTH});
            expect(res.code).toBe("OK");
            const prices = (res.data as any[]).map((r: any) => r.price);
            for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
        });

        test("pagination", async () => {
            const p1 = await raw("GET", "/api/query/products?order=asc.id&pageNo=1&pageSize=5", {auth: AUTH});
            const p2 = await raw("GET", "/api/query/products?order=asc.id&pageNo=2&pageSize=5", {auth: AUTH});
            expect(p1.pageNo).toBe(1);
            expect(p1.pageSize).toBe(5);
            expect(typeof p1.total).toBe("number");
            if ((p2.data as any[]).length > 0) {
                const last1 = (p1.data as any[])[(p1.data as any[]).length - 1];
                const first2 = (p2.data as any[])[0];
                expect(first2.id).toBeGreaterThan(last1.id);
            }
        });
    });

    /* ── GET /api/query/:table/:pk ── */

    describe("GET /api/query/:table/:pk", () => {
        test("get by pk", async () => {
            const res = await raw("GET", "/api/query/products/1", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(res.data).not.toBeNull();
            expect((res.data as any).id).toBe(1);
        });

        test("get by pk not found", async () => {
            const res = await raw("GET", "/api/query/products/99999", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(res.data).toBeNull();
        });
    });

    /* ── POST /api/query/:table — Body 查询 ── */

    describe("POST /api/query/products (body)", () => {

        test("where 二元组", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH, body: {where: ["is_active", 1]},
            });
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.is_active).toBe(1);
        });

        test("where 三元组", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH, body: {where: ["price", "gt", 500]},
            });
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.price).toBeGreaterThan(500);
        });

        test("where 逻辑组合 or", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH,
                body: {where: [{op: "or", cond: [["category", "eq", "Books"], ["category", "eq", "Toys"]]}]},
            });
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(["Books", "Toys"]).toContain(r.category);
        });

        test("select + group + order + page", async () => {
            const res = await raw("POST", "/api/query/products", {
                auth: AUTH,
                body: {
                    select: ["category", "count:id:total"],
                    group: ["category"],
                    order: [{field: "category", dir: "asc"}],
                    pageNo: 1, pageSize: 5,
                },
            });
            expect(res.code).toBe("OK");
            expect(res.pageNo).toBe(1);
            expect(typeof res.total).toBe("number");
        });
    });

    /* ── DELETE /api/delete/:table — URL 参数 ── */

    describe("DELETE /api/delete/products (URL params)", () => {

        test("setup + delete eq", async () => {
            for (let i = 0; i < 3; i++) {
                await raw("POST", "/api/save/products", {
                    auth: AUTH,
                    body: {name: `UrlDel_${i}`, price: 0.001, stock: i, category: "UrlDelCat"},
                });
            }
            const res = await raw("DELETE", "/api/delete/products?name=UrlDel_0", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(1);
        });

        test("delete like", async () => {
            const res = await raw("DELETE", "/api/delete/products?name=like.UrlDel*", {auth: AUTH});
            expect(res.code).toBe("OK");
            const check = await raw("GET", "/api/query/products?category=UrlDelCat", {auth: AUTH});
            expect((check.data as any[]).length).toBe(0);
        });

        test("delete or", async () => {
            await raw("POST", "/api/save/products", {
                auth: AUTH,
                body: [
                    {name: "OrDel_A", price: 0.001, stock: 0, category: "OrDelCatA"},
                    {name: "OrDel_B", price: 0.002, stock: 0, category: "OrDelCatB"},
                ],
            });
            const res = await raw("DELETE",
                "/api/delete/products?or=category.eq.OrDelCatA,category.eq.OrDelCatB", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });
    });

    /* ── DELETE /api/delete/:table/:pk ── */

    describe("DELETE /api/delete/:table/:pk", () => {
        test("delete by pk", async () => {
            const cr = await raw("POST", "/api/save/products", {
                auth: AUTH, body: {name: "PkDel", price: 0.001, stock: 0, category: "PkDel"},
            });
            const id = (cr.data as any).created[0];
            const res = await raw("DELETE", `/api/delete/products/${id}`, {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any).deleted).toContain(id);
            const check = await raw("GET", `/api/query/products/${id}`, {auth: AUTH});
            expect(check.data).toBeNull();
        });
    });

    /* ── POST /api/delete/:table — Body 删除 ── */

    describe("POST /api/delete/products (body)", () => {

        test("body: 三元组", async () => {
            await raw("POST", "/api/save/products", {
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
            expect((res.data as any).deleted.length).toBeGreaterThanOrEqual(2);
        });

        test("body: or 条件", async () => {
            await raw("POST", "/api/save/products", {
                auth: AUTH,
                body: [
                    {name: "BDOr1", price: 0.001, stock: 0, category: "BDOrCat1"},
                    {name: "BDOr2", price: 0.002, stock: 0, category: "BDOrCat2"},
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

    /* ── POST /api/save/:table — 严格插入 ── */

    describe("POST /api/save/products (raw)", () => {
        test("create single", async () => {
            const res = await raw("POST", "/api/save/products", {
                auth: AUTH, body: {name: "RawCreate", price: 42, stock: 10, category: "RawTest"},
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).created.length).toBe(1);
        });

        test("create batch", async () => {
            const res = await raw("POST", "/api/save/products", {
                auth: AUTH, body: [
                    {name: "RawBatchA", price: 10, stock: 5, category: "RawTest"},
                    {name: "RawBatchB", price: 20, stock: 8, category: "RawTest"},
                ],
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).created.length).toBe(2);
        });

        test("conflict on existing PK", async () => {
            const res = await raw("POST", "/api/save/products", {
                auth: AUTH, body: {id: 1, name: "Conflict", price: 1},
            });
            expect(res.code).toBe("CONFLICT");
        });
    });

    /* ── PUT /api/save/:table — Upsert ── */

    describe("PUT /api/save/products (raw)", () => {
        test("upsert update existing", async () => {
            const res = await raw("PUT", "/api/save/products", {
                auth: AUTH, body: {id: 2, price: 777.77},
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).updated).toContain(2);
            const check = await raw("GET", "/api/query/products/2", {auth: AUTH});
            expect((check.data as any).price).toBe(777.77);
        });

        test("upsert create new", async () => {
            const res = await raw("PUT", "/api/save/products", {
                auth: AUTH, body: {name: "UpsertNew", price: 55, stock: 1, category: "Upsert"},
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).created.length).toBe(1);
        });
    });

    /* ── PATCH /api/save/:table — 严格更新 ── */

    describe("PATCH /api/save/products (raw)", () => {
        test("update existing", async () => {
            const res = await raw("PATCH", "/api/save/products", {
                auth: AUTH, body: {id: 2, price: 666.66},
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).updated).toContain(2);
            const check = await raw("GET", "/api/query/products/2", {auth: AUTH});
            expect((check.data as any).price).toBe(666.66);
        });

        test("not found", async () => {
            const res = await raw("PATCH", "/api/save/products", {
                auth: AUTH, body: {id: 99999, price: 1},
            });
            expect(res.code).toBe("NOT_FOUND");
        });

        test("missing PK", async () => {
            const res = await raw("PATCH", "/api/save/products", {
                auth: AUTH, body: {price: 1},
            });
            expect(res.code).toBe("VALIDATION_ERROR");
        });

        test("batch update", async () => {
            const res = await raw("PATCH", "/api/save/products", {
                auth: AUTH, body: [
                    {id: 1, rating: 5.0},
                    {id: 2, rating: 4.0},
                ],
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).updated.length).toBe(2);
        });
    });

    /* ── POST /api/update/:table — 条件批量更新 ── */

    describe("POST /api/update/products (raw)", () => {

        test("setup test data", async () => {
            await raw("POST", "/api/save/products", {
                auth: AUTH, body: [
                    {name: "UpTest1", price: 100, stock: 10, category: "UpCat"},
                    {name: "UpTest2", price: 200, stock: 20, category: "UpCat"},
                    {name: "UpTest3", price: 300, stock: 30, category: "UpCat"},
                ],
            });
        });

        test("update by condition", async () => {
            const res = await raw("POST", "/api/update/products", {
                auth: AUTH,
                body: {
                    set: {stock: 999},
                    where: ["category", "eq", "UpCat"],
                },
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).updated.length).toBeGreaterThanOrEqual(3);

            const check = await raw("POST", "/api/query/products", {
                auth: AUTH, body: {where: ["category", "eq", "UpCat"]},
            });
            for (const r of check.data as any[]) {
                expect(r.stock).toBe(999);
            }
        });

        test("update with complex where", async () => {
            const res = await raw("POST", "/api/update/products", {
                auth: AUTH,
                body: {
                    set: {is_active: 0},
                    where: [["category", "eq", "UpCat"], ["price", "gt", 150]],
                },
            });
            expect(res.code).toBe("OK");
            expect((res.data as any).updated.length).toBeGreaterThanOrEqual(2);
        });

        test("empty where rejected", async () => {
            const res = await raw("POST", "/api/update/products", {
                auth: AUTH,
                body: {set: {price: 0}, where: []},
            });
            expect(res.code).toBe("QUERY_ERROR");
        });

        test("cleanup", async () => {
            await raw("POST", "/api/delete/products", {
                auth: AUTH, body: ["category", "eq", "UpCat"],
            });
        });
    });

    /* ── Raw test cleanup ── */

    describe("cleanup raw test data", () => {
        test("delete RawTest category", async () => {
            await raw("POST", "/api/delete/products", {
                auth: AUTH, body: ["category", "eq", "RawTest"],
            });
        });
        test("delete Upsert category", async () => {
            await raw("POST", "/api/delete/products", {
                auth: AUTH, body: ["category", "eq", "Upsert"],
            });
        });
    });

    /* ── logs (no owner) ── */

    describe("GET /api/query/logs (no owner)", () => {
        test("query all", async () => {
            const res = await raw("GET", "/api/query/logs", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect((res.data as any[]).length).toBeGreaterThan(0);
        });

        test("query with filter", async () => {
            const res = await raw("GET", "/api/query/logs?level=ERROR", {auth: AUTH});
            expect(res.code).toBe("OK");
            for (const r of res.data as any[]) expect(r.level).toBe("ERROR");
        });

        test("pagination", async () => {
            const res = await raw("GET", "/api/query/logs?pageNo=1&pageSize=10&order=desc.id", {auth: AUTH});
            expect(res.code).toBe("OK");
            expect(res.pageNo).toBe(1);
        });

        test("group by level", async () => {
            const res = await raw("GET", "/api/query/logs?select=level,count:id:cnt&group=level", {auth: AUTH});
            expect(res.code).toBe("OK");
            const levels = (res.data as any[]).map((r: any) => r.level);
            expect(new Set(levels).size).toBe(levels.length);
        });
    });
});

/* ═══════════ Part 3: Content-Type 校验 ═══════════ */

describe("Content-Type validation", () => {
    /** 发送不带 Content-Type: application/json 的请求 */
    async function rawNoJson(
        method: string, path: string,
        opts?: { auth?: string; body?: string },
    ): Promise<ApiResponse> {
        const headers: Record<string, string> = {};
        if (opts?.auth) headers["Authorization"] = opts.auth;
        const init: RequestInit = {method, headers};
        if (opts?.body !== undefined) init.body = opts.body;
        const res = await fetch(`${BASE}${path}`, init);
        return res.json() as Promise<ApiResponse>;
    }

    test("POST without Content-Type should return VALIDATION_ERROR", async () => {
        const res = await rawNoJson("POST", "/api/query/products", {
            auth: AUTH,
            body: '{"where":["id","eq","1"]}',
        });
        expect(res.code).toBe("VALIDATION_ERROR");
        expect(res.message).toContain("application/json");
    });

    test("PUT without Content-Type should return VALIDATION_ERROR", async () => {
        const res = await rawNoJson("PUT", "/api/save/products", {
            auth: AUTH,
            body: '{"name":"test","price":1}',
        });
        expect(res.code).toBe("VALIDATION_ERROR");
        expect(res.message).toContain("application/json");
    });

    test("PATCH without Content-Type should return VALIDATION_ERROR", async () => {
        const res = await rawNoJson("PATCH", "/api/save/products", {
            auth: AUTH,
            body: '{"id":1,"name":"test"}',
        });
        expect(res.code).toBe("VALIDATION_ERROR");
        expect(res.message).toContain("application/json");
    });

    test("GET should work without Content-Type", async () => {
        const res = await rawNoJson("GET", "/api/query/products", {auth: AUTH});
        expect(res.code).toBe("OK");
    });

    test("DELETE should work without Content-Type", async () => {
        const res = await rawNoJson("DELETE", "/api/delete/products/99999", {auth: AUTH});
        // 不管记录存不存在，不应该报 VALIDATION_ERROR
        expect(res.code).not.toBe("VALIDATION_ERROR");
    });
});
