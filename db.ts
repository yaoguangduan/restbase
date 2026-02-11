/**
 * db.ts — 数据库连接、表结构分析、初始化校验
 *
 * 启动时：
 *   1. 确保 auth 表存在（不存在则创建最小结构）
 *   2. 获取全部表的列名、类型、主键、是否有 owner 字段
 *   3. 校验 auth 表必须包含 id / username / password
 */
import { cfg, q, AppError, reqStore } from "./types.ts";
import { log } from "./logger.ts";

/* ═══════════ 元数据类型 ═══════════ */

export interface ColMeta {
  name: string;
  type: string;       // 原始类型（小写）
  isNumeric: boolean;
}

export interface TblMeta {
  name: string;
  columns: ColMeta[];
  colMap: Map<string, ColMeta>;  // name → ColMeta（快速查找）
  pk: string | null;              // 主键字段名
  hasOwner: boolean;              // 是否含 owner 字段
}

/* ═══════════ 全局表缓存 ═══════════ */

const tables = new Map<string, TblMeta>();

export const getTable = (name: string) => tables.get(name);
export const allTables = () => tables;
export const isAuthTable = (name: string) => name === cfg.authTable;

/* ═══════════ 数据库实例 ═══════════ */

export const db = new Bun.SQL(cfg.db);

/** 执行 SQL（DEBUG 模式自动打印完整 SQL + 参数 + requestId） */
export async function run(sql: string, values?: unknown[]): Promise<any[]> {
  if (cfg.logLevel === "DEBUG") {
    const requestId = reqStore.getStore()?.requestId;
    log.debug({ requestId, sql, params: values }, "SQL");
  }
  return (await db.unsafe(sql, values)) as any[];
}

/* ═══════════ 初始化入口 ═══════════ */

export async function initDb() {
  await ensureAuthTable();
  /* 加载用户指定的初始化 SQL */
  if (cfg.initSql) await loadInitSql();
  const names = await listTables();
  for (const n of names) tables.set(n, await introspect(n));
  validateAuth();
  log.info({ tables: [...tables.keys()] }, `DB loaded ${tables.size} table(s)`);
}

/** 序列化单张表元数据 */
function serializeMeta(meta: TblMeta) {
  return {
    name: meta.name,
    pk: meta.pk,
    hasOwner: meta.hasOwner,
    columns: meta.columns.map((c) => ({
      name: c.name, type: c.type, isNumeric: c.isNumeric,
    })),
  };
}

/** 获取所有非 auth 表的元数据（供 /api/meta/tables 使用） */
export function getTablesMeta() {
  const result: ReturnType<typeof serializeMeta>[] = [];
  for (const [name, meta] of tables) {
    if (name === cfg.authTable) continue;
    result.push(serializeMeta(meta));
  }
  return result;
}

/** 获取指定表的元数据（供 /api/meta/tables/:name 使用） */
export function getTableMetaByName(name: string) {
  if (name === cfg.authTable) return null;
  const meta = tables.get(name);
  return meta ? serializeMeta(meta) : null;
}

/** 运行时重新同步数据库表结构（供 /api/meta/sync 使用） */
export async function syncTablesMeta() {
  tables.clear();
  const names = await listTables();
  for (const n of names) tables.set(n, await introspect(n));
  validateAuth();
  log.info({ tables: [...tables.keys()] }, `Synced ${tables.size} table(s)`);
  return getTablesMeta();
}

/** 读取并执行 DB_INIT_SQL 指定的 SQL 文件 */
async function loadInitSql() {
  const file = Bun.file(cfg.initSql);
  if (!(await file.exists())) {
    log.warn({ path: cfg.initSql }, "DB_INIT_SQL file not found, skipping");
    return;
  }
  const content = await file.text();
  /* 移除单行注释后按分号分割 */
  const cleaned = content.replace(/--.*$/gm, "");
  const stmts = cleaned.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of stmts) {
    await db.unsafe(stmt);
  }
  log.info({ path: cfg.initSql, statements: stmts.length }, "Executed init SQL");
}

/* ═══════════ 确保 auth 表存在 ═══════════ */

async function ensureAuthTable() {
  const tbl = q(cfg.authTable);
  if (cfg.isSqlite) {
    await db.unsafe(`CREATE TABLE IF NOT EXISTS ${tbl} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    )`);
  } else {
    await db.unsafe(`CREATE TABLE IF NOT EXISTS ${tbl} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL
    )`);
  }
}

/* ═══════════ 获取所有表名 ═══════════ */

async function listTables(): Promise<string[]> {
  const rows = cfg.isSqlite
    ? await db.unsafe(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
    : await db.unsafe(
        `SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()`,
      );
  return (rows as any[]).map((r) => r.name);
}

/* ═══════════ 分析单张表结构 ═══════════ */

async function introspect(table: string): Promise<TblMeta> {
  const columns: ColMeta[] = [];
  let pk: string | null = null;

  if (cfg.isSqlite) {
    for (const r of (await db.unsafe(`PRAGMA table_info(${q(table)})`)) as any[]) {
      const type = (r.type || "text").toLowerCase();
      columns.push({ name: r.name, type, isNumeric: NUM_RE.test(type) });
      if (r.pk === 1) pk = r.name;
    }
  } else {
    const rows = await db.unsafe(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY
       FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'
       ORDER BY ORDINAL_POSITION`,
    );
    for (const r of rows as any[]) {
      const type = (r.DATA_TYPE || "varchar").toLowerCase();
      columns.push({ name: r.COLUMN_NAME, type, isNumeric: NUM_RE.test(type) });
      if (r.COLUMN_KEY === "PRI") pk = r.COLUMN_NAME;
    }
  }

  const colMap = new Map(columns.map((c) => [c.name, c]));
  return { name: table, columns, colMap, pk, hasOwner: colMap.has(cfg.ownerField) };
}

/** 数值型类型正则 */
const NUM_RE = /int|real|float|double|decimal|numeric/;

/* ═══════════ 校验 auth 表 ═══════════ */

function validateAuth() {
  const m = tables.get(cfg.authTable);
  if (!m) throw new Error(`Auth table "${cfg.authTable}" not found`);
  for (const f of ["id", "username", "password"]) {
    if (!m.colMap.has(f))
      throw new Error(`Auth table "${cfg.authTable}" missing required column: "${f}"`);
  }
}
