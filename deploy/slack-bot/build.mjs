#!/usr/bin/env node
/**
 * Builds the Slack bot's Lambda artifact: one zip holding both handlers.
 *
 *   pnpm slack:bundle          →  dist/slack-bot/slack-bot-lambda.zip
 *
 *   Ingress function handler:  ingress.handler
 *   Worker function handler:   worker.handler
 *
 * Only the `sat-cli onboard --chat` answering path goes in. The CLI's commands, code review, SCM
 * and ingestion integrations are unreachable from the two handlers, and the build fails if any of
 * them slips in. Of the model providers, only those the bot can be deployed with are included:
 * Bedrock (@langchain/aws), and for the Appendix alternatives Claude on Azure AI Foundry
 * (@langchain/anthropic) and a GPT deployment on Azure (@langchain/openai). The rest stay external,
 * and the worker names the misconfiguration at cold start if SATENG_MODEL points at one of them.
 *
 * Two stages, because typedi wires services from the constructor metadata TypeScript emits, and
 * esbuild cannot emit it:
 *   1. tsc compiles src/ with emitDecoratorMetadata (tsconfig.build.json, so tests stay out and the output is rooted at src);
 *   2. esbuild bundles that JavaScript, where the metadata is by then ordinary code.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// A namespace import: a named import of crc32 would fail at load on old Node, before the check.
import * as zlib from "node:zlib";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "dist", "slack-bot");
const COMPILED = join(OUT, "tsc");
const BUNDLE = join(OUT, "bundle");
const ZIP = join(OUT, "slack-bot-lambda.zip");

/** Lambda's direct-upload limit. Above it the console needs the zip staged in S3 first. */
const DIRECT_UPLOAD_LIMIT = 50 * 1024 * 1024;

/** LLM providers the bot does not use. Left out of the bundle rather than shipped unused. */
const EXCLUDED_PROVIDERS = ["@langchain/google-genai", "@langchain/ollama", "@langchain/xai", "@langchain/community"];

/** Anything matching these in the bundle means the chat-only boundary has been crossed. */
const FORBIDDEN_INPUTS = [
    /\/src\/commands\//,
    /\/src\/containers\//,
    /\/src\/services\/review\//,
    /\/src\/services\/normalizers\//,
    /\/src\/integrations\/(github|gitlab|bitbucket|jira|confluence|google-drive|scm)\//,
    /node_modules\/.*(@octokit|@inquirer|marked-terminal|mammoth|turndown|commander)\//,
    /node_modules\/.*@langchain\/(google-genai|ollama|xai|community)\//,
];

function step(message) {
    console.log(`\n▸ ${message}`);
}

function compile() {
    step("Compiling TypeScript (keeps the decorator metadata typedi needs)");
    rmSync(OUT, { recursive: true, force: true });
    const tsc = spawnSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "-p",
            join(ROOT, "tsconfig.build.json"),
            "--outDir",
            COMPILED,
            "--declaration",
            "false",
            "--declarationMap",
            "false",
        ],
        { stdio: "inherit" },
    );
    if (tsc.status !== 0) throw new Error("TypeScript compilation failed.");
}

async function bundle() {
    step("Bundling the two handlers");
    const result = await build({
        entryPoints: {
            ingress: join(COMPILED, "entrypoints", "slack-ingress.lambda.js"),
            worker: join(COMPILED, "entrypoints", "slack-worker.lambda.js"),
        },
        outdir: BUNDLE,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "cjs",
        external: EXCLUDED_PROVIDERS,
        // Whitespace and syntax only: identifiers are kept so stack traces in CloudWatch read.
        minifyWhitespace: true,
        minifySyntax: true,
        sourcemap: "linked",
        sourcesContent: false,
        metafile: true,
        logLevel: "warning",
        legalComments: "none",
    });

    const inputs = Object.keys(result.metafile.inputs).map((path) => path.split(sep).join("/"));
    const violations = inputs.filter((path) => FORBIDDEN_INPUTS.some((pattern) => pattern.test(`/${path}`)));
    if (violations.length > 0) {
        throw new Error(
            `The bundle reaches code outside the onboard --chat path:\n  ${violations.join("\n  ")}\n` +
                "Find the import that pulls it in, or widen FORBIDDEN_INPUTS only if the chat path now needs it.",
        );
    }

    for (const [file, { bytes }] of Object.entries(result.metafile.outputs)) {
        if (file.endsWith(".js")) console.log(`  ${relative(ROOT, file)}  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    }
}

/** A minimal zip writer (deflate, no directories), so the build needs no zip tool installed. */
function writeZip(sourceDir, target) {
    step("Packaging");
    const files = readdirSync(sourceDir)
        .filter((name) => statSync(join(sourceDir, name)).isFile())
        .sort();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const name of files) {
        const data = readFileSync(join(sourceDir, name));
        const compressed = zlib.deflateRawSync(data, { level: 9 });
        const nameBytes = Buffer.from(name, "utf8");
        const checksum = zlib.crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt32LE(0, 10); // time/date: fixed, for reproducible zips
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBytes, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x031e, 4); // made by: UNIX, so the mode below is honoured
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(0, 12);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);

        offset += local.length + nameBytes.length + compressed.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.concat([...locals, ...centrals, end]));
    return statSync(target).size;
}

async function main() {
    if (typeof zlib.crc32 !== "function") {
        throw new Error(`Node ${process.versions.node} is too old to package the zip — use Node 22.2 or newer.`);
    }
    compile();
    await bundle();
    const size = writeZip(BUNDLE, ZIP);
    rmSync(COMPILED, { recursive: true, force: true });

    console.log(`\n✔ ${relative(ROOT, ZIP)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
    console.log("  Ingress handler: ingress.handler");
    console.log("  Worker handler:  worker.handler");
    if (size > DIRECT_UPLOAD_LIMIT) {
        console.log("  Over 50 MB: upload it to S3 and use “Upload from → Amazon S3 location” in the Lambda console.");
    }
}

main().catch((err) => {
    console.error(`\n✘ ${err.message}`);
    process.exit(1);
});
