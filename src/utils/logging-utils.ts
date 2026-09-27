import log4js from "log4js";
import { join } from "path";

export async function configureLogging(args: string[], cwd: string): Promise<void> {
    const isDebug = args.includes("--debug");
    const isQuiet = args.includes("--quiet");

    log4js.configure({
        appenders: {
            console: {
                type: "stdout",
                layout: { type: "pattern", pattern: "%m" },
            },
            file: {
                type: "file",
                filename: join(cwd, "logs", "sateng.log"),
                maxLogSize: 10485760,
                backups: 3,
            },
        },
        categories: {
            default: {
                appenders: isQuiet ? ["file"] : ["console", "file"],
                level: isDebug ? "debug" : "info",
            },
        },
    });
}

/**
 * Logging for long-running services (the Slack bot) rather than the CLI: stdout only, since a
 * Lambda's filesystem is read-only outside /tmp and CloudWatch collects stdout anyway, and with
 * level and category in every line, since nobody is watching a terminal to tell them apart.
 * log4js logs nothing at all until configured, so every service entrypoint must call this first.
 */
export function configureServiceLogging(level: string = process.env.LOG_LEVEL ?? "info"): void {
    log4js.configure({
        appenders: {
            console: { type: "stdout", layout: { type: "pattern", pattern: "%p [%c] %m" } },
        },
        categories: { default: { appenders: ["console"], level } },
    });
}

export function shimConsole(): void {
    const logger = log4js.getLogger("console");
    console.log = (...args: unknown[]) => logger.info(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => logger.warn(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logger.error(args.map(String).join(" "));
    console.debug = (...args: unknown[]) => logger.debug(args.map(String).join(" "));
}

export async function waitForLogsToFlush(): Promise<void> {
    return new Promise((resolve) => {
        log4js.shutdown(() => resolve());
    });
}
