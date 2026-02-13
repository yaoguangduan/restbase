/**
 * restbase-client.ts — RestBase 前端客户端
 *
 * 零依赖、纯 TypeScript，浏览器 / Node / Bun / Deno 通用。
 *
 * 路由结构：
 *   /api/auth/*               — 鉴权
 *   /api/query/:table         — GET URL 查询 / POST Body 查询
 *   /api/query/:table/:pk     — GET 按主键取单条
 *   /api/delete/:table        — DELETE URL 删除 / POST Body 删除
 *   /api/delete/:table/:pk    — DELETE 按主键删除
 *   /api/update/:table        — POST 条件批量更新
 *   /api/save/:table          — POST 插入 / PUT Upsert / PATCH 严格更新
 *
 * @example
 * ```ts
 * const rb = new RestBase("http://localhost:3333");
 * await rb.auth.login("admin", "admin");
 * const data = await rb.table("products").query().where(gt("price", 100)).data();
 * ```
 */

/* ══════════════════════════════════════════════════════════════
   统一响应类型
   ══════════════════════════════════════════════════════════════ */

export interface ApiResponse<T = unknown> {
    code: string;
    message?: string;
    data: T;
    pageNo?: number;
    pageSize?: number;
    total?: number;
}

/** 表元数据 */
export interface TableMeta {
    name: string;
    pk: string | null;
    hasOwner: boolean;
    columns: { name: string; type: string; isNumeric: boolean }[];
}

/* ══════════════════════════════════════════════════════════════
   WHERE 条件 DSL（与服务端 Body 格式一一对应）
   ══════════════════════════════════════════════════════════════ */

/** 条件节点（内部表示，直接序列化为服务端 JSON） */
export type Condition =
    | { type: "tuple"; field: string; op: string; value: unknown }
    | { type: "group"; logic: "and" | "or"; children: Condition[] };

/* ── 比较运算符 ── */

export const eq = (f: string, v: unknown): Condition =>
    ({type: "tuple", field: f, op: "eq", value: v});

export const ne = (f: string, v: unknown): Condition =>
    ({type: "tuple", field: f, op: "ne", value: v});

export const gt = (f: string, v: unknown): Condition =>
    ({type: "tuple", field: f, op: "gt", value: v});

export const ge = (f: string, v: unknown): Condition =>
    ({type: "tuple", field: f, op: "ge", value: v});

export const lt = (f: string, v: unknown): Condition =>
    ({type: "tuple", field: f, op: "lt", value: v});

export const le = (f: string, v: unknown): Condition =>
    ({type: "tuple", field: f, op: "le", value: v});

/* ── NULL 判断 ── */

export const isNull = (f: string): Condition =>
    ({type: "tuple", field: f, op: "is", value: null});

export const isNotNull = (f: string): Condition =>
    ({type: "tuple", field: f, op: "nis", value: null});

/* ── LIKE ── */

export const like = (f: string, pattern: string): Condition =>
    ({type: "tuple", field: f, op: "like", value: pattern});

export const nlike = (f: string, pattern: string): Condition =>
    ({type: "tuple", field: f, op: "nlike", value: pattern});

/* ── IN / NOT IN / BETWEEN ── */

export const isIn = (f: string, values: unknown[]): Condition =>
    ({type: "tuple", field: f, op: "in", value: values});

export const notIn = (f: string, values: unknown[]): Condition =>
    ({type: "tuple", field: f, op: "nin", value: values});

export const between = (f: string, lo: unknown, hi: unknown): Condition =>
    ({type: "tuple", field: f, op: "between", value: [lo, hi]});

/* ── 逻辑组合 ── */

export const and = (...conds: Condition[]): Condition =>
    ({type: "group", logic: "and", children: conds});

export const or = (...conds: Condition[]): Condition =>
    ({type: "group", logic: "or", children: conds});

/* ── 序列化为服务端 where 数组 ── */

function condToBody(c: Condition): unknown {
    if (c.type === "tuple") {
        return [c.field, c.op, c.value];
    }
    return {op: c.logic, cond: c.children.map(condToBody)};
}

function conditionsToWhere(conds: Condition[]): unknown {
    if (conds.length === 0) return undefined;
    if (conds.length === 1) return condToBody(conds[0]!);
    return conds.map(condToBody);
}

/* ══════════════════════════════════════════════════════════════
   SELECT 项构建器
   ══════════════════════════════════════════════════════════════ */

export interface SelectItem {
    field: string;
    alias?: string;
    fn?: string;
}

/* ── 类型安全 SELECT：编译期推导查询结果类型 ── */

/** 展平交叉类型为扁平对象 */
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * 映射单个 select 参数到输出类型
 *
 * 优先级（从高到低）：
 *   1. 字符串且为 keyof T               → Pick<T, field>
 *   2. "func:field:alias" 模板           → { alias: number }
 *   3. "field:alias" (field ∈ keyof T)   → { alias: T[field] }（字段重命名）
 *   4. "func:field" (func ∉ keyof T)     → { "func:field": number }（聚合，key = 原字符串）
 *   5. 对象且含 fn + alias（聚合）       → { alias: number }
 *   6. 对象含 field + alias（重命名）    → { alias: T[field] }
 *   7. 对象仅含 field                    → Pick<T, field>
 */
type MapSelectArg<T, Item> =
    Item extends keyof T & string ? { [K in Item]: T[Item] }
        : Item extends `${string}:${string}:${infer A}` ? { [K in A]: number }
            : Item extends `${infer F}:${infer A}`
                ? F extends keyof T ? { [K in A]: T[F] } : { [K in Item & string]: number }
                : Item extends { fn: string; alias: infer A extends string } ? { [K in A]: number }
                    : Item extends { field: infer F; alias: infer A extends string }
                        ? F extends keyof T ? { [K in A]: T[F] } : {}
                        : Item extends { field: infer F }
                            ? F extends keyof T & string ? { [K in F]: T[F] } : {}
                            : {};

/** 递归合并 select 参数元组为单一对象类型 */
type MergeSelectArgs<T, Items extends readonly unknown[]> =
    Items extends readonly [infer H, ...infer R]
        ? MapSelectArg<T, H> & MergeSelectArgs<T, R>
        : {};

/** 普通字段或带别名（保留字面量类型） */
export function sel<F extends string>(field: F): { field: F; alias: undefined; fn: undefined };
export function sel<F extends string, A extends string>(field: F, alias: A): { field: F; alias: A; fn: undefined };
export function sel(field: string, alias?: string): any {
    return {field, alias, fn: undefined};
}

/** 聚合函数（保留 alias 字面量类型；无 alias 时默认 "fn:field"） */
export function agg<Fn extends string, F extends string>(fn: Fn, field: F): { field: F; fn: Fn; alias: `${Fn}:${F}` };
export function agg<A extends string>(fn: string, field: string, alias: A): { field: string; fn: string; alias: A };
export function agg(fn: string, field: string, alias?: string): any {
    return {field, alias: alias ?? `${fn}:${field}`, fn};
}

function selectToBody(items: (string | SelectItem)[]): unknown[] {
    return items.map((item) => {
        if (typeof item === "string") return item;
        if (item.fn && item.alias) return {field: item.field, func: item.fn, alias: item.alias};
        if (item.fn) return {field: item.field, func: item.fn};
        if (item.alias) return {field: item.field, alias: item.alias};
        return item.field;
    });
}

/* ══════════════════════════════════════════════════════════════
   ORDER 构建器
   ══════════════════════════════════════════════════════════════ */

interface OrderEntry {
    field: string;
    dir: "asc" | "desc"
}

function orderToBody(entries: OrderEntry[]): unknown[] {
    return entries.map((e) => ({field: e.field, dir: e.dir}));
}

/* ══════════════════════════════════════════════════════════════
   QueryBuilder — 链式查询（POST /api/query/:table）
   ══════════════════════════════════════════════════════════════ */

/**
 * QueryBuilder — 链式查询，类型安全的 select
 *
 * 泛型参数：
 *   T = 原始表类型（始终不变，用于约束 select 参数）
 *   S = 投影后的输出类型（由 select() 推导，默认等于 T）
 *
 * @example
 * ```ts
 * interface Product { id: number; name: string; price: number; stock: number }
 * const q = rb.table<Product>("products").query();
 *
 * // S = { name: string; price: number }
 * const a = await q.select("name", "price").data();
 *
 * // S = { unitPrice: number; name: string }
 * const b = await q.select(sel("price", "unitPrice"), "name").data();
 *
 * // S = { category: string; total: number; avgPrice: number }
 * const c = await q.select("category", agg("count","id","total"), agg("avg","price","avgPrice"))
 *                   .groupBy("category").data();
 * ```
 */
export class QueryBuilder<T = Record<string, unknown>, S = T> {
    private _conditions: Condition[] = [];
    private _select: (string | SelectItem)[] = [];
    private _order: OrderEntry[] = [];
    private _group: string[] = [];
    private _pageNo?: number;
    private _pageSize?: number;
    private _execFn: (body: unknown) => Promise<ApiResponse<any[]>>;

    constructor(execFn: (body: unknown) => Promise<ApiResponse<any[]>>) {
        this._execFn = execFn;
    }

    /** 添加 WHERE 条件（多次调用为 AND 关系） */
    where(...conditions: Condition[]): QueryBuilder<T, S> {
        this._conditions.push(...conditions);
        return this;
    }

    /**
     * 指定查询字段 — 自动推导返回类型
     *
     * - `"field"` → 保留原类型 `{ field: T[field] }`
     * - `sel("price", "unitPrice")` → 重命名 `{ unitPrice: T["price"] }`
     * - `agg("count", "id", "total")` → 聚合 `{ total: number }`
     * - `"func:field:alias"` → 模板推导 `{ alias: number }`
     */
    select<const Items extends readonly ((keyof T & string) | (string & {}) | SelectItem)[]>(
        ...items: Items
    ): QueryBuilder<T, Prettify<MergeSelectArgs<T, Items>>> {
        this._select.push(...(items as any));
        return this as any;
    }

    /** 升序排序 */
    orderAsc(...fields: string[]): QueryBuilder<T, S> {
        for (const f of fields) this._order.push({field: f, dir: "asc"});
        return this;
    }

    /** 降序排序 */
    orderDesc(...fields: string[]): QueryBuilder<T, S> {
        for (const f of fields) this._order.push({field: f, dir: "desc"});
        return this;
    }

    /** 分组 */
    groupBy(...fields: string[]): QueryBuilder<T, S> {
        this._group.push(...fields);
        return this;
    }

    /** 分页 */
    page(pageNo: number, pageSize: number): QueryBuilder<T, S> {
        this._pageNo = pageNo;
        this._pageSize = pageSize;
        return this;
    }

    /** 构建请求 Body */
    build(): Record<string, unknown> {
        const body: Record<string, unknown> = {};
        const w = conditionsToWhere(this._conditions);
        if (w !== undefined) body.where = w;
        if (this._select.length > 0) body.select = selectToBody(this._select);
        if (this._order.length > 0) body.order = orderToBody(this._order);
        if (this._group.length > 0) body.group = this._group;
        if (this._pageNo !== undefined) body.pageNo = this._pageNo;
        if (this._pageSize !== undefined) body.pageSize = this._pageSize;
        return body;
    }

    /** 执行查询，返回完整响应（类型随 select 变化） */
    async exec(): Promise<ApiResponse<S[]>> {
        return this._execFn(this.build()) as any;
    }

    /** 仅返回数据数组 */
    async data(): Promise<S[]> {
        const res = await this.exec();
        return res.data ?? [];
    }

    /** 返回第一条 */
    async first(): Promise<S | null> {
        const res = await this.page(1, 1).exec();
        return res.data?.[0] ?? null;
    }
}

/* ══════════════════════════════════════════════════════════════
   DeleteBuilder — 链式条件删除（POST /api/delete/:table）
   ══════════════════════════════════════════════════════════════ */

export class DeleteBuilder {
    private _conditions: Condition[] = [];
    private _execFn: (body: unknown) => Promise<ApiResponse<{ deleted: unknown[] }>>;

    constructor(execFn: (body: unknown) => Promise<ApiResponse<{ deleted: unknown[] }>>) {
        this._execFn = execFn;
    }

    /** 添加 WHERE 条件 */
    where(...conditions: Condition[]): this {
        this._conditions.push(...conditions);
        return this;
    }

    /** 执行删除，返回被删除记录的主键列表 */
    async exec(): Promise<ApiResponse<{ deleted: unknown[] }>> {
        const body = conditionsToWhere(this._conditions) ?? [];
        return this._execFn(body);
    }
}

/* ══════════════════════════════════════════════════════════════
   UpdateBuilder — 链式条件批量更新（POST /api/update/:table）
   ══════════════════════════════════════════════════════════════ */

export class UpdateBuilder {
    private _set: Record<string, unknown> = {};
    private _conditions: Condition[] = [];
    private _execFn: (body: unknown) => Promise<ApiResponse<{ updated: unknown[] }>>;

    constructor(execFn: (body: unknown) => Promise<ApiResponse<{ updated: unknown[] }>>) {
        this._execFn = execFn;
    }

    /** 设置要更新的字段值 */
    set(data: Record<string, unknown>): this {
        Object.assign(this._set, data);
        return this;
    }

    /** 添加 WHERE 条件 */
    where(...conditions: Condition[]): this {
        this._conditions.push(...conditions);
        return this;
    }

    /** 执行更新，返回被更新记录的主键列表 */
    async exec(): Promise<ApiResponse<{ updated: unknown[] }>> {
        const body = {
            set: this._set,
            where: conditionsToWhere(this._conditions) ?? [],
        };
        return this._execFn(body);
    }
}

/* ══════════════════════════════════════════════════════════════
   TableClient — 单表操作
   ══════════════════════════════════════════════════════════════ */

export class TableClient<T = Record<string, unknown>> {
    private _http: HttpClient;
    private _name: string;

    constructor(http: HttpClient, name: string) {
        this._http = http;
        this._name = name;
    }

    /** 创建链式查询（POST /api/query/:table） */
    query(): QueryBuilder<T> {
        return new QueryBuilder<T>((body) =>
            this._http.post<T[]>(`/api/query/${this._name}`, body),
        );
    }

    /** 按主键获取单条（GET /api/query/:table/:pk） */
    async get(id: string | number): Promise<ApiResponse<T | null>> {
        return this._http.get<T | null>(`/api/query/${this._name}/${id}`);
    }

    /** 严格插入（POST /api/save/:table），已存在则报错，返回 { created: [主键值...] } */
    async insert(data: Partial<T> | Partial<T>[]): Promise<ApiResponse<{ created: unknown[] }>> {
        return this._http.post<{ created: unknown[] }>(`/api/save/${this._name}`, data);
    }

    /** Upsert：不存在插入、存在增量更新（PUT /api/save/:table），返回 { created: [...], updated: [...] } */
    async upsert(data: Partial<T> | Partial<T>[]): Promise<ApiResponse<{ created: unknown[]; updated: unknown[] }>> {
        return this._http.put<{ created: unknown[]; updated: unknown[] }>(`/api/save/${this._name}`, data);
    }

    /** 严格更新：不存在报错，必须带 PK（PATCH /api/save/:table），返回 { updated: [...] } */
    async update(data: Partial<T> | Partial<T>[]): Promise<ApiResponse<{ updated: unknown[] }>> {
        return this._http.patch<{ updated: unknown[] }>(`/api/save/${this._name}`, data);
    }

    /** 按主键删除（DELETE /api/delete/:table/:pk），返回 { deleted: [主键值] } */
    async delete(id: string | number): Promise<ApiResponse<{ deleted: unknown[] }>> {
        return this._http.delete<{ deleted: unknown[] }>(`/api/delete/${this._name}/${id}`);
    }

    /** 创建链式条件删除（POST /api/delete/:table） */
    deleteWhere(): DeleteBuilder {
        return new DeleteBuilder((body) =>
            this._http.post<{ deleted: unknown[] }>(`/api/delete/${this._name}`, body),
        );
    }

    /** 创建链式条件批量更新（POST /api/update/:table） */
    updateWhere(): UpdateBuilder {
        return new UpdateBuilder((body) =>
            this._http.post<{ updated: unknown[] }>(`/api/update/${this._name}`, body),
        );
    }
}

/* ══════════════════════════════════════════════════════════════
   AuthClient — 鉴权
   ══════════════════════════════════════════════════════════════ */

export class AuthClient {
    private _http: HttpClient;

    constructor(http: HttpClient) {
        this._http = http;
    }

    /** 登录，成功后自动设置 JWT token */
    async login(username: string, password: string): Promise<ApiResponse<string>> {
        const res = await this._http.post<string>("/api/auth/login", {username, password});
        if (res.code === "OK" && res.data) this._http.setToken(res.data);
        return res;
    }

    /** 注册，成功后自动设置 JWT token */
    async register(username: string, password: string): Promise<ApiResponse<string>> {
        const res = await this._http.post<string>("/api/auth/register", {username, password});
        if (res.code === "OK" && res.data) this._http.setToken(res.data);
        return res;
    }

    /** 获取当前用户资料 */
    async getProfile<P = Record<string, unknown>>(): Promise<ApiResponse<P>> {
        return this._http.get<P>("/api/auth/profile");
    }

    /** 更新当前用户资料 */
    async updateProfile(data: Record<string, unknown>): Promise<ApiResponse<null>> {
        return this._http.post<null>("/api/auth/profile", data);
    }

    /** 手动设置 token（如从 localStorage 恢复） */
    setToken(token: string): void {
        this._http.setToken(token);
    }

    /** 获取当前 token */
    getToken(): string | null {
        return this._http.getToken();
    }

    /** 清除 token（登出） */
    logout(): void {
        this._http.setToken(null);
    }

    /** 切换为 Basic Auth */
    useBasicAuth(username: string, password: string): void {
        this._http.setBasicAuth(username, password);
    }
}

/* ══════════════════════════════════════════════════════════════
   HttpClient — 底层 HTTP（内部使用）
   ══════════════════════════════════════════════════════════════ */

class HttpClient {
    private _urls: string[];
    private _token: string | null = null;
    private _basicAuth: string | null = null;
    private _requestId?: string;
    private _headers: Record<string, string> = {};

    constructor(urls: string | string[]) {
        const list = Array.isArray(urls) ? urls : [urls];
        this._urls = list.map((u) => u.replace(/\/+$/, ""));
    }

    /** Pick a random base URL (load balancing) */
    private _pickUrl(): string {
        return this._urls[Math.floor(Math.random() * this._urls.length)]!;
    }

    setToken(token: string | null): void {
        this._token = token;
        this._basicAuth = null;
    }

    getToken(): string | null {
        return this._token;
    }

    setBasicAuth(username: string, password: string): void {
        /* Unicode-safe base64: TextEncoder 处理非 ASCII 字符 */
        const bytes = new TextEncoder().encode(`${username}:${password}`);
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        this._basicAuth = btoa(binary);
        this._token = null;
    }

    setRequestId(id: string | undefined): void {
        this._requestId = id;
    }

    setHeader(key: string, value: string): void {
        this._headers[key] = value;
    }

    get<T>(path: string, params?: Record<string, string>): Promise<ApiResponse<T>> {
        return this._fetch<T>("GET", path, params);
    }

    post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
        return this._fetch<T>("POST", path, undefined, body);
    }

    put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
        return this._fetch<T>("PUT", path, undefined, body);
    }

    patch<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
        return this._fetch<T>("PATCH", path, undefined, body);
    }

    delete<T>(path: string, params?: Record<string, string>): Promise<ApiResponse<T>> {
        return this._fetch<T>("DELETE", path, params);
    }

    private _buildHeaders(): Record<string, string> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            ...this._headers,
        };
        if (this._token) h["Authorization"] = `Bearer ${this._token}`;
        else if (this._basicAuth) h["Authorization"] = `Basic ${this._basicAuth}`;
        if (this._requestId) h["X-Request-Id"] = this._requestId;
        return h;
    }

    private async _fetch<T>(method: string, path: string, params?: Record<string, string>, body?: unknown): Promise<ApiResponse<T>> {
        let url = `${this._pickUrl()}${path}`;
        if (params && Object.keys(params).length > 0) {
            url += `?${new URLSearchParams(params).toString()}`;
        }
        const init: RequestInit = {method, headers: this._buildHeaders()};
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await fetch(url, init);
        return (await res.json()) as ApiResponse<T>;
    }
}

/* ══════════════════════════════════════════════════════════════
   RestBase — 主入口
   ══════════════════════════════════════════════════════════════ */

/**
 * RestBase — 前端客户端主入口
 *
 * 支持三种构造方式：
 *
 * ```ts
 * // 1. 同源部署（无参数）
 * const rb = new RestBase();
 *
 * // 2. 单个 endpoint
 * const rb = new RestBase("http://localhost:3333");
 *
 * // 3. 多个 endpoint（负载均衡，每次请求随机选一个）
 * const rb = new RestBase([
 *   "http://localhost:3333",
 *   "http://localhost:8080",
 *   "http://localhost:9090",
 * ]);
 * ```
 *
 * 多 endpoint 模式下，所有服务端实例应连接同一个数据库。
 * 客户端共享同一套 auth 状态，每次请求随机分发到不同节点。
 */
export class RestBase {
    readonly auth: AuthClient;
    private _http: HttpClient;

    constructor(endpoint?: string | string[]) {
        this._http = new HttpClient(endpoint ?? "");
        this.auth = new AuthClient(this._http);
    }

    /** 获取表操作客户端 */
    table<T = Record<string, unknown>>(name: string): TableClient<T> {
        return new TableClient<T>(this._http, name);
    }

    /** 健康检查 */
    async health(): Promise<ApiResponse> {
        return this._http.get("/api/health");
    }

    /** 获取所有表元数据（不含 users 表） */
    async tables(): Promise<ApiResponse<TableMeta[]>> {
        return this._http.get<TableMeta[]>("/api/meta/tables");
    }

    /** 获取指定表的元数据 */
    async tableMeta(name: string): Promise<ApiResponse<TableMeta | null>> {
        return this._http.get<TableMeta | null>(`/api/meta/tables/${name}`);
    }

    /** 运行时同步数据库表结构（新建表后调用） */
    async syncMeta(): Promise<ApiResponse<TableMeta[]>> {
        return this._http.get<TableMeta[]>("/api/meta/sync");
    }

    /** 设置自定义请求头（当前 endpoint） */
    setHeader(key: string, value: string): this {
        this._http.setHeader(key, value);
        return this;
    }

    /** 设置请求追踪 ID（当前 endpoint） */
    setRequestId(id: string): this {
        this._http.setRequestId(id);
        return this;
    }
}

export default RestBase;
