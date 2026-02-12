#!/usr/bin/env bun
/**
 * bin/restbase.ts — CLI entry point (stateless management)
 *
 * Commands:
 *   restbase run              Start server in foreground (reads .env)
 *   restbase start            Start server in background (daemon)
 *   restbase stop <pid|name|all>  Stop instance(s) by PID, name or all
 *   restbase status               Show running instances (table + health check)
 *   restbase log <pid|name>       Tail log of a background instance
 *   restbase env              Generate .env template in current directory
 *   restbase version          Show version
 *   restbase help             Show help
 *
 * All configuration is read from .env in the current working directory.
 *
 * Instance discovery is stateless:
 *   - `restbase start` spawns the child with a `--port=N` marker arg
 *   - Management commands use `ps` to find processes matching `restbase.*--port=`
 *   - Detailed info (name, logFile, cwd, uptime…) is fetched via /api/health
 */

import {spawn, execSync} from "child_process";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    writeFileSync,
} from "fs";
import {resolve, join} from "path";
import {readFileSync} from "fs";
import {homedir} from "os";
import * as p from "@clack/prompts";

/* ═══════════ Global paths ═══════════ */

const RESTBASE_HOME = resolve(homedir(), ".restbase");
const LOGS_DIR = join(RESTBASE_HOME, "logs");

function ensureLogDir() {
    mkdirSync(LOGS_DIR, {recursive: true});
}

/* ═══════════ Process discovery via ps ═══════════ */

interface PsInstance {
    pid: number;
    port: number;
}

/**
 * Scan running processes for `restbase.*--port=N` and extract PID + port.
 * Works on macOS and Linux.
 */
function discoverInstances(): PsInstance[] {
    try {
        const out = execSync("ps -eo pid,args", {encoding: "utf-8"});
        const results: PsInstance[] = [];
        for (const line of out.split("\n")) {
            const match = line.match(/^\s*(\d+)\s+.*restbase.*--port=(\d+)/);
            if (match) {
                results.push({pid: Number(match[1]), port: Number(match[2])});
            }
        }
        return results;
    } catch {
        return [];
    }
}

/* ═══════════ Process helpers ═══════════ */

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

interface HealthInfo {
    status: string;
    name?: string;
    port?: number;
    pid?: number;
    cwd?: string;
    logFile?: string;
    startedAt?: string;
    uptime?: number;
    memory?: { rss: number; heapUsed: number; heapTotal: number; external: number };
    cpu?: { user: number; system: number };
}

async function fetchHealth(port: number): Promise<HealthInfo | null> {
    try {
        const res = await fetch(`http://localhost:${port}/api/health`, {
            signal: AbortSignal.timeout(2000),
        });
        const body = (await res.json()) as any;
        return body?.code === "OK" ? (body.data as HealthInfo) : null;
    } catch {
        return null;
    }
}

/** Build the command to re-spawn ourselves */
function getSelfCommand(): string[] {
    if (
        process.argv[1] &&
        (process.argv[1].endsWith(".ts") || process.argv[1].endsWith(".js"))
    ) {
        return [process.execPath, process.argv[1]];
    }
    return [process.execPath];
}

/* ═══════════ Commands ═══════════ */

/** run — foreground, reads .env as-is */
async function cmdRun() {
    await import("../src/server.ts");
}

/** start — daemon mode, waits for health check before reporting success */
async function cmdStart() {
    ensureLogDir();

    const port = Number(process.env.SVR_PORT) || 3333;

    // Reject if this port is already running
    for (const inst of discoverInstances()) {
        if (inst.port === port) {
            console.log(`RestBase already running on port ${port} (PID: ${inst.pid})`);
            return;
        }
    }

    // Build child env: silence console, ensure LOG_FILE for daemon
    const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        LOG_CONSOLE: "false",
    };
    if (!process.env.LOG_FILE) {
        env.LOG_FILE = join(LOGS_DIR, `${port}.log`);
    }

    // stdout/stderr → crash log (truncate so we only see this run's output)
    const stdoutPath = join(LOGS_DIR, `${port}.out`);
    const out = openSync(stdoutPath, "w");
    const err = openSync(stdoutPath, "w");

    const self = getSelfCommand();
    const child = spawn(self[0]!, [...self.slice(1), "run", `--port=${port}`], {
        detached: true,
        stdio: ["ignore", out, err],
        env,
        cwd: process.cwd(),
    });
    child.unref();

    /* 父进程不再需要这些 fd，关闭防止泄漏 */
    closeSync(out);
    closeSync(err);

    /* 轮询健康检查，确认子进程真正启动成功 */
    const pid = child.pid!;
    const maxWait = 10_000;
    const interval = 500;
    const startTime = Date.now();
    let healthy = false;

    while (Date.now() - startTime < maxWait) {
        /* 子进程已退出则立即终止等待 */
        if (!isAlive(pid)) break;

        const health = await fetchHealth(port);
        if (health?.status === "healthy") {
            healthy = true;
            break;
        }
        await new Promise((r) => setTimeout(r, interval));
    }

    if (healthy) {
        console.log(`RestBase started (PID: ${pid}, port: ${port})`);
    } else {
        console.error(`RestBase failed to start (PID: ${pid}, port: ${port})`);
        /* 读取 crash log 末尾帮助诊断 */
        try {
            const crashLog = readFileSync(stdoutPath, "utf-8");
            const lines = crashLog.trim().split("\n");
            const tail = lines.slice(-20).join("\n");
            if (tail) {
                console.error("\n── Last output from child process ──");
                console.error(tail);
                console.error("────────────────────────────────────");
            }
        } catch { /* ignore read errors */ }
        process.exit(1);
    }
}

/**
 * Resolve a target identifier to matching instances.
 * Supports: "all", numeric PID, or SVR_NAME (fetched from health endpoint).
 */
async function resolveInstances(target: string): Promise<{ pid: number; port: number; name?: string }[]> {
    const all = discoverInstances();
    if (all.length === 0) return [];
    if (target === "all") return all;

    // Try numeric PID first
    const num = parseInt(target, 10);
    if (!isNaN(num)) {
        const byPid = all.find((i) => i.pid === num);
        if (byPid) return [byPid];
        // Maybe it's a port number?
        const byPort = all.find((i) => i.port === num);
        if (byPort) return [byPort];
        return [];
    }

    // Otherwise treat as SVR_NAME — need to fetch health for each to match
    const matched: { pid: number; port: number; name?: string }[] = [];
    for (const inst of all) {
        const health = await fetchHealth(inst.port);
        if (health?.name === target) {
            matched.push({...inst, name: health.name});
        }
    }
    return matched;
}

/** stop — by PID, name, or "all" */
async function cmdStop(target: string) {
    const instances = await resolveInstances(target);
    if (instances.length === 0) {
        console.log(target === "all" ? "No RestBase instances found" : `No instance found matching "${target}"`);
        return;
    }
    for (const inst of instances) stopOne(inst.pid, inst.port, inst.name);
}

function stopOne(pid: number, port?: number, name?: string) {
    const label = [name, port ? `port ${port}` : ""].filter(Boolean).join(", ");
    try {
        if (isAlive(pid)) {
            process.kill(pid, "SIGTERM");
            console.log(`Stopped PID ${pid}${label ? ` (${label})` : ""}`);
        } else {
            console.log(`Process ${pid} is not running`);
        }
    } catch {
        console.log(`Failed to stop PID ${pid}`);
    }
}

/** Format seconds into human readable uptime */
function fmtUptime(sec: number): string {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h < 24) return `${h}h${m}m`;
    const d = Math.floor(h / 24);
    return `${d}d${h % 24}h`;
}

/** Format bytes into human readable size */
function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

/** Format CPU microseconds into human readable percentage (approx) */
function fmtCpu(userUs: number, systemUs: number, uptimeSec: number): string {
    if (uptimeSec <= 0) return "-";
    const totalUs = userUs + systemUs;
    const pct = (totalUs / (uptimeSec * 1_000_000)) * 100;
    return `${pct.toFixed(1)}%`;
}

/** Format ISO timestamp to local short form: MM-DD HH:mm:ss */
function fmtTime(iso: string): string {
    const d = new Date(iso);
    const MM = String(d.getMonth() + 1).padStart(2, "0");
    const DD = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${MM}-${DD} ${hh}:${mm}:${ss}`;
}

/** status — table with health check */
async function cmdStatus() {
    const instances = discoverInstances();
    if (instances.length === 0) {
        console.log("No RestBase instances found");
        return;
    }

    // Column widths
    const nW = 14, pW = 9, sW = 14, ptW = 7, stW = 17, uW = 10, mW = 10, cW = 8;

    console.log(
        "NAME".padEnd(nW) +
        "PID".padEnd(pW) +
        "STATE".padEnd(sW) +
        "PORT".padEnd(ptW) +
        "STARTED".padEnd(stW) +
        "UPTIME".padEnd(uW) +
        "MEM".padEnd(mW) +
        "CPU".padEnd(cW) +
        "LOG",
    );
    console.log("─".repeat(nW + pW + sW + ptW + stW + uW + mW + cW + 30));

    for (const inst of instances) {
        // Fetch live info from health endpoint
        const health = await fetchHealth(inst.port);

        const name = health?.name || "-";
        const state = health?.status ?? "unreachable";
        const started = health?.startedAt ? fmtTime(health.startedAt) : "-";
        const uptime = health?.uptime !== undefined ? fmtUptime(health.uptime) : "-";
        const mem = health?.memory ? fmtBytes(health.memory.rss) : "-";
        const cpu = (health?.cpu && health?.uptime)
            ? fmtCpu(health.cpu.user, health.cpu.system, health.uptime)
            : "-";
        const logPath = health?.logFile || "-";

        console.log(
            name.padEnd(nW) +
            String(inst.pid).padEnd(pW) +
            state.padEnd(sW) +
            String(inst.port).padEnd(ptW) +
            started.padEnd(stW) +
            uptime.padEnd(uW) +
            mem.padEnd(mW) +
            cpu.padEnd(cW) +
            logPath,
        );
    }
}

/** log — tail -f the log file of an instance (by PID or name) */
async function cmdLog(target: string) {
    const instances = await resolveInstances(target);
    if (instances.length === 0) {
        console.error(`No running RestBase instance found matching "${target}"`);
        process.exit(1);
    }
    if (instances.length > 1) {
        console.error(`Multiple instances match "${target}". Use PID to be specific:`);
        for (const i of instances) console.error(`  PID ${i.pid} (port ${i.port})`);
        process.exit(1);
    }

    const inst = instances[0]!;

    // Fetch log file path from health endpoint (points to current.log symlink)
    const health = await fetchHealth(inst.port);
    if (!health?.logFile) {
        console.error(`Cannot determine log file for PID ${inst.pid} (health endpoint unreachable or logFile not configured)`);
        process.exit(1);
    }

    if (!existsSync(health.logFile)) {
        console.error(`Log file not found: ${health.logFile}`);
        process.exit(1);
    }

    console.log(`Tailing ${health.logFile} (Ctrl+C to stop)\n`);

    const tail = spawn("tail", ["-f", "-n", "100", health.logFile], {
        stdio: "inherit",
    });

    process.on("SIGINT", () => {
        tail.kill();
        process.exit(0);
    });

    await new Promise<void>((resolve) => tail.on("close", () => resolve()));
}

/* ═══════════ Interactive env configuration ═══════════ */

/** Parse an existing .env file into a key→value map */
function parseEnvFile(path: string): Record<string, string> {
    const map: Record<string, string> = {};
    if (!existsSync(path)) return map;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        map[key] = val;
    }
    return map;
}

/** Interactive env — prompt user for each config parameter */
async function cmdEnv() {
    const nodeEnv = process.env.NODE_ENV;
    const envFile = nodeEnv ? `.env.${nodeEnv}` : ".env";
    const envPath = resolve(process.cwd(), envFile);
    const existing = parseEnvFile(envPath);
    const isUpdate = Object.keys(existing).length > 0;

    p.intro(isUpdate ? `Reconfigure ${envFile} (current values as defaults)` : `Initialize ${envFile} configuration`);

    /* helper: get default — existing value > built-in default */
    const d = (key: string, fallback: string) => existing[key] ?? fallback;

    /* helper: wrap clack text — returns string (empty if user skipped) */
    const ask = async (opts: { message: string; key: string; fallback: string; placeholder?: string }) => {
        const result = await p.text({
            message: opts.message,
            initialValue: d(opts.key, opts.fallback),
            placeholder: opts.placeholder,
        });
        if (p.isCancel(result)) { p.cancel("Cancelled"); process.exit(0); }
        return (result as string).trim();
    };

    /* helper: select */
    const choose = async (opts: { message: string; key: string; fallback: string; options: { value: string; label: string }[] }) => {
        const result = await p.select({
            message: opts.message,
            initialValue: d(opts.key, opts.fallback),
            options: opts.options,
        });
        if (p.isCancel(result)) { p.cancel("Cancelled"); process.exit(0); }
        return result as string;
    };

    // ── Server ──
    p.log.step("Server");

    const SVR_NAME = await ask({
        message: "Instance name (shown in 'restbase status')",
        key: "SVR_NAME", fallback: "", placeholder: "optional",
    });
    const SVR_PORT = await ask({
        message: "Server port",
        key: "SVR_PORT", fallback: "3333",
    });
    const SVR_STATIC = await ask({
        message: "Static file directory for SPA hosting",
        key: "SVR_STATIC", fallback: "", placeholder: "optional, e.g. dist",
    });
    const SVR_API_LIMIT = await ask({
        message: "Rate limit (max requests per second per API, 0 = off)",
        key: "SVR_API_LIMIT", fallback: "100",
    });
    const SVR_CORS_ORIGIN = await ask({
        message: "CORS allowed origins (comma-separated, * = all)",
        key: "SVR_CORS_ORIGIN", fallback: "*", placeholder: "e.g. https://example.com",
    });

    // ── Database ──
    p.log.step("Database");

    const DB_URL = await ask({
        message: "Database URL (sqlite://<path> or mysql://user:pass@host/db)",
        key: "DB_URL", fallback: "sqlite://:memory:",
    });
    const DB_AUTH_TABLE = await ask({
        message: "Auth table name",
        key: "DB_AUTH_TABLE", fallback: "users",
    });
    const DB_AUTH_FIELD = await ask({
        message: "Owner field name (tenant isolation)",
        key: "DB_AUTH_FIELD", fallback: "owner",
    });
    const DB_AUTH_FIELD_NULL_OPEN = await choose({
        message: "Treat owner=NULL rows as public data?",
        key: "DB_AUTH_FIELD_NULL_OPEN", fallback: "false",
        options: [
            {value: "false", label: "false — NULL rows are hidden"},
            {value: "true", label: "true — NULL rows are visible to everyone"},
        ],
    });
    const DB_INIT_SQL = await ask({
        message: "SQL file to run on startup",
        key: "DB_INIT_SQL", fallback: "", placeholder: "optional, e.g. init.sql",
    });

    // ── Auth ──
    p.log.step("Auth");

    const AUTH_JWT_SECRET = await ask({
        message: "JWT secret (⚠ change in production!)",
        key: "AUTH_JWT_SECRET", fallback: "restbase",
    });
    const AUTH_JWT_EXP = await ask({
        message: "JWT expiry in seconds (default: 12 hours)",
        key: "AUTH_JWT_EXP", fallback: "43200",
    });
    const AUTH_BASIC_OPEN = await choose({
        message: "Enable Basic Auth?",
        key: "AUTH_BASIC_OPEN", fallback: "true",
        options: [
            {value: "true", label: "true — Basic Auth enabled"},
            {value: "false", label: "false — JWT only"},
        ],
    });

    // ── Logging ──
    p.log.step("Logging");

    const LOG_LEVEL = await choose({
        message: "Log level",
        key: "LOG_LEVEL", fallback: "INFO",
        options: [
            {value: "ERROR", label: "ERROR — errors only"},
            {value: "INFO", label: "INFO — requests + errors"},
            {value: "DEBUG", label: "DEBUG — verbose (headers, body, SQL)"},
        ],
    });
    const LOG_CONSOLE = await choose({
        message: "Console output? (auto-disabled in daemon mode)",
        key: "LOG_CONSOLE", fallback: "true",
        options: [
            {value: "true", label: "true — print to console"},
            {value: "false", label: "false — silent"},
        ],
    });
    const LOG_FILE = await ask({
        message: "Log file path (auto-configured in daemon mode)",
        key: "LOG_FILE", fallback: "", placeholder: "optional, e.g. log/app.log",
    });
    const LOG_RETAIN_DAYS = await ask({
        message: "Log file retention days",
        key: "LOG_RETAIN_DAYS", fallback: "7",
    });

    // ── Build .env content ──
    const line = (key: string, val: string, comment: string) =>
        val ? `${key}=${val}${comment ? `  # ${comment}` : ""}` : `# ${key}=${comment ? `  # ${comment}` : ""}`;

    const lines = [
        "# ═══════════════════════════════════════════════════════════",
        "# RestBase Configuration",
        "# ═══════════════════════════════════════════════════════════",
        "",
        "# ── Server ────────────────────────────────────────────────",
        line("SVR_NAME", SVR_NAME, "Instance name"),
        line("SVR_PORT", SVR_PORT, "Server port"),
        line("SVR_STATIC", SVR_STATIC, "Static file directory"),
        line("SVR_API_LIMIT", SVR_API_LIMIT, "Rate limit per API"),
        line("SVR_CORS_ORIGIN", SVR_CORS_ORIGIN, "CORS origins (* = all)"),
        "",
        "# ── Database ──────────────────────────────────────────────",
        line("DB_URL", DB_URL, ""),
        line("DB_AUTH_TABLE", DB_AUTH_TABLE, "Auth table name"),
        line("DB_AUTH_FIELD", DB_AUTH_FIELD, "Owner field"),
        line("DB_AUTH_FIELD_NULL_OPEN", DB_AUTH_FIELD_NULL_OPEN, ""),
        line("DB_INIT_SQL", DB_INIT_SQL, "SQL file on startup"),
        "",
        "# ── Auth ──────────────────────────────────────────────────",
        line("AUTH_JWT_SECRET", AUTH_JWT_SECRET, "⚠ change in production"),
        line("AUTH_JWT_EXP", AUTH_JWT_EXP, "seconds"),
        line("AUTH_BASIC_OPEN", AUTH_BASIC_OPEN, ""),
        "",
        "# ── Logging ───────────────────────────────────────────────",
        line("LOG_LEVEL", LOG_LEVEL, "ERROR / INFO / DEBUG"),
        line("LOG_CONSOLE", LOG_CONSOLE, ""),
        line("LOG_FILE", LOG_FILE, "auto-configured in daemon mode"),
        line("LOG_RETAIN_DAYS", LOG_RETAIN_DAYS, "days"),
        "",
    ];

    writeFileSync(envPath, lines.join("\n"));
    p.outro(`Saved to ${envPath}`);
}

/** version */
async function cmdVersion() {
    const pkg = (await import("../package.json")).default;
    console.log(`RestBase v${pkg.version}`);
}

/** help */
function printHelp() {
    console.log(`
RestBase — Zero-code REST API server for SQLite / MySQL

Usage:
  restbase <command> [arguments]

Commands:
  run              Start server in foreground (reads .env)
  start            Start server in background (daemon mode)
  stop <pid|name|all>   Stop instance(s) by PID, SVR_NAME, or all
  status                Show all running background instances
  log <pid|name>        Tail the log of an instance by PID or SVR_NAME
  env              Interactive .env configuration (create or reconfigure)
  version          Show version
  help             Show this help

Examples:
  restbase run                Start in foreground
  restbase start              Start in background (daemon)
  restbase status             List running instances with health status
  restbase log 12345          Tail log by PID
  restbase log my-api         Tail log by SVR_NAME
  restbase stop 12345         Stop instance by PID
  restbase stop my-api        Stop instance by SVR_NAME
  restbase stop all           Stop all background instances
  restbase env                Interactive .env setup (reconfigure if exists)

Configuration:
  All settings are read from .env in the current working directory.
  Run 'restbase env' for interactive configuration (create or update .env).

Instance discovery:
  Background instances are discovered via 'ps' — no PID files needed.
  Instance details (name, log path, uptime…) are fetched from /api/health.
`);
}

/* ═══════════ Main ═══════════ */

const command = process.argv[2] || "run";
const arg1 = process.argv[3];

switch (command) {
    case "run":
        await cmdRun();
        break;

    case "start":
        await cmdStart();
        process.exit(0);
        break;

    case "stop":
        if (!arg1) {
            console.error("Usage: restbase stop <pid|name|all>");
            process.exit(1);
        }
        await cmdStop(arg1);
        process.exit(0);
        break;

    case "status":
        await cmdStatus();
        process.exit(0);
        break;

    case "log":
        if (!arg1) {
            console.error("Usage: restbase log <pid|name>");
            process.exit(1);
        }
        await cmdLog(arg1);
        break;

    case "env":
        await cmdEnv();
        process.exit(0);
        break;

    case "version":
    case "-v":
    case "--version":
        await cmdVersion();
        process.exit(0);
        break;

    case "help":
    case "-h":
    case "--help":
        printHelp();
        process.exit(0);
        break;

    default:
        console.error(`Unknown command: ${command}`);
        console.error("Run 'restbase help' for usage.");
        process.exit(1);
}
