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
