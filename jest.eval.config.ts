import type { Config } from "jest";

/**
 * Eval suite config. Kept separate from jest.config.ts because these tests make real LLM and
 * Bedrock calls: they cost money and need a live Knowledge Base, so they must never run as part
 * of `pnpm test` in CI.
 */
const config: Config = {
    preset: "ts-jest",
    testEnvironment: "node",
    testMatch: ["**/tests/eval/**/*.eval.ts"],
    testTimeout: 180_000,
};

export default config;
