/**
 * logger.ts — 基于 pino 的统一日志
 *
 * 支持：
 *   - 控制台输出（LOG_CONSOLE，默认 true，纯文本格式）
 *   - 文件输出（LOG_FILE，NDJSON 格式，pino-roll 按天+按大小滚动）
 *   - 日志保留天数（LOG_RETAIN_DAYS，默认 7）
 *   - 日志等级（LOG_LEVEL）
 *
 * pino-roll 启用 symlink，当前日志始终通过 current.log 软链接访问。
 *
 * 导出 log 实例，全局使用 log.info / log.debug / log.error / log.fatal
 */
import pino from "pino";
import {dirname, join} from "path";
import {rmSync} from "fs";
import {cfg} from "./types.ts";

/* ═══════════ pino level 映射 ═══════════ */

const LEVEL_MAP: Record<string, string> = {
    ERROR: "error",
    INFO: "info",
    DEBUG: "debug",
};
const pinoLevel = LEVEL_MAP[cfg.logLevel] ?? "info";

/* ═══════════ 控制台纯文本流 ═══════════ */

function createTextStream(): pino.DestinationStream {
    return {
        write(chunk: string) {
            try {
                const obj = JSON.parse(chunk);
                const ts = obj.time || new Date().toISOString();
                const level = (obj.level || "INFO").padEnd(5);
                const msg = obj.msg || "";
                const {level: _, time: _t, pid: _p, hostname: _h, msg: _m, ...rest} = obj;
                const extra = Object.keys(rest).length > 0
                    ? " " + Object.entries(rest).map(([k, v]) =>
                    `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`
                ).join(" ")
                    : "";
                process.stdout.write(`${ts} ${level} ${msg}${extra}\n`);
            } catch {
                process.stdout.write(chunk);
            }
        },
    } as pino.DestinationStream;
}

/* ═══════════ 构建 multistream ═══════════ */

const streams: pino.StreamEntry[] = [];

/* 控制台（纯文本） */
if (cfg.logConsole) {
    streams.push({
        level: pinoLevel as pino.Level,
        stream: createTextStream(),
    });
}

/* 文件（pino-roll 滚动写入 NDJSON，symlink 指向当前文件） */
if (cfg.logFile) {
    /* pino-roll 的 symlink 选项在 current.log 已存在时会抛 EEXIST，
       启动前无条件清理残留文件（可能是符号链接或普通文件）避免崩溃 */
    const symlinkPath = join(dirname(cfg.logFile), "current.log");
    try { rmSync(symlinkPath, {force: true}); } catch { /* ignore */ }

    const {default: buildRollStream} = await import("pino-roll");
    const rollStream = await buildRollStream({
        file: cfg.logFile,
        frequency: "daily",
        size: "20m",
        dateFormat: "yyyy-MM-dd",
        limit: {count: cfg.logRetainDays},
        mkdir: true,
        symlink: true,
    });

    streams.push({
        level: pinoLevel as pino.Level,
        stream: rollStream,
    });
}

/* ═══════════ 创建 logger ═══════════ */

export const log: pino.Logger =
    streams.length > 0
        ? pino(
            {
                level: pinoLevel,
                formatters: {
                    level(label) {
                        return {level: label.toUpperCase()};
                    },
                },
                timestamp: () => `,"time":"${new Date().toISOString()}"`,
            },
            pino.multistream(streams),
        )
        : pino({level: pinoLevel, enabled: false});
