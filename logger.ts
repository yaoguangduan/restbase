/**
 * logger.ts — 基于 pino 的统一日志
 *
 * 使用 pino.multistream（主线程同步），避免 Bun 下 transport worker 兼容性问题。
 *
 * 支持：
 *   - 控制台输出（LOG_CONSOLE，默认 true，pino-pretty 彩色格式化）
 *   - 文件输出（LOG_FILE，NDJSON 格式，level/time 可读化，pino-roll 按天+按大小滚动）
 *   - 日志保留天数（LOG_RETAIN_DAYS，默认 7）
 *   - 日志等级（LOG_LEVEL）
 *
 * 导出 log 实例，全局使用 log.info / log.debug / log.error / log.fatal
 */
import pino from "pino";
import pretty from "pino-pretty";
import { cfg } from "./types.ts";

/* ═══════════ pino level 映射 ═══════════ */

const LEVEL_MAP: Record<string, string> = {
  ERROR: "error",
  INFO: "info",
  DEBUG: "debug",
};
const pinoLevel = LEVEL_MAP[cfg.logLevel] ?? "info";

/* ═══════════ 构建 multistream ═══════════ */

const streams: pino.StreamEntry[] = [];

/* 控制台（pino-pretty 带颜色） */
if (cfg.logConsole) {
  streams.push({
    level: pinoLevel as pino.Level,
    stream: pretty({
      colorize: true,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
      ignore: "hostname",
    }),
  });
}

/* 文件（pino-roll 滚动写入，直接写 NDJSON，level/time 已由 formatters 格式化） */
if (cfg.logFile) {
  const { default: buildRollStream } = await import("pino-roll");
  const rollStream = await buildRollStream({
    file: cfg.logFile,
    frequency: "daily",
    size: "20m",
    dateFormat: "yyyy-MM-dd",
    limit: { count: cfg.logRetainDays },
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
          /* level 数字 → 可读字符串（30 → "INFO"） */
          formatters: {
            level(label) {
              return { level: label.toUpperCase() };
            },
          },
          /* 时间戳用 ISO 格式 */
          timestamp: () => `,"time":"${new Date().toISOString()}"`,
        },
        pino.multistream(streams),
      )
    : pino({ level: pinoLevel, enabled: false }); // 全关则禁用
