#!/usr/bin/env node

const { execSync } = require("child_process");
const { existsSync } = require("fs");
const { dirname, join } = require("path");

const PROJECT_DIRECTORY = dirname(__dirname);
const BUILD_DIR = join(PROJECT_DIRECTORY, "built");

function isInstalledPackage() {
    return !existsSync(join(PROJECT_DIRECTORY, ".git"));
}

async function isDevelopment() {
    if (process.env.SATENG_FORCE_DEV === "true") {
        return true;
    }
    try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: PROJECT_DIRECTORY }).toString().trim();
        if (branch !== "main") {
            console.warn(`You are not on the main branch. This is a development build.`);
            return true;
        }
    } catch {
        // not a git repo
    }
    return false;
}

async function invokeCli(command, args, extraEnv) {
    const crossSpawn = require("cross-spawn");
    const which = require("which");
    const pnpm = which.sync("pnpm");

    const child = crossSpawn(pnpm, ["--silent", command, ...args], {
        cwd: PROJECT_DIRECTORY,
        stdio: "inherit",
        env: { ...process.env, ...extraEnv },
        shell: false,
    });

    process.on("SIGINT", () => {
        if (process.platform !== "win32" && child.pid) {
            process.kill(child.pid, "SIGINT");
        }
    });

    await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`CLI failed with code ${code}`))));
    });
}

async function main() {
    process.on("exit", () => {
        process.stdin.setRawMode?.(false);
    });

    const args = process.argv.slice(2);
    const installed = isInstalledPackage();

    if (installed) {
        const { spawn } = require("child_process");
        const mainPath = join(BUILD_DIR, "entrypoints", "main.js");
        const child = spawn(process.execPath, [mainPath, ...args], {
            cwd: PROJECT_DIRECTORY,
            stdio: "inherit",
            env: {
                ...process.env,
                SATENG_ORIGINAL_CWD: process.cwd(),
                SATENG_DEV: "false",
            },
        });
        process.on("SIGINT", () => {
            if (process.platform !== "win32" && child.pid) {
                process.kill(child.pid, "SIGINT");
            }
        });
        const exitCode = await new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("close", resolve);
        });
        process.exit(exitCode ?? 1);
    }

    const isDev = await isDevelopment();
    const extraEnv = { SATENG_ORIGINAL_CWD: process.cwd(), SATENG_DEV: String(isDev) };
    const command = isDev ? "start:dev" : "start";

    try {
        await invokeCli(command, args, extraEnv);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
