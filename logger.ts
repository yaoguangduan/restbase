/**
 * logger.ts — 基于 pino 的统一日志
 *
 * 支持：
 *   - 控制台输出（LOG_CONSOLE，默认 true，纯文本格式）
 *   - 文件输出（LOG_FILE，NDJSON 格式，pino-roll 按天+按大小滚动）
 *   - 日志保留天数（LOG_RETAIN_DAYS，默认 7）
 *   - 日志等级（LOG_LEVEL）
 *
 * 导出 log 实例，全局使用 log.info / log.debug / log.error / log.fatal
 */
import pino from "pino";
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

/* 文件（pino-roll 滚动写入 NDJSON） */
if (cfg.logFile) {
    const {default: buildRollStream} = await import("pino-roll");
    const rollStream = await buildRollStream({
        file: cfg.logFile,
        frequency: "daily",
        size: "20m",
        dateFormat: "yyyy-MM-dd",
        limit: {count: cfg.logRetainDays},
        mkdir: true,
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
