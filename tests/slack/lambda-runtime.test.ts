import { LLMModel } from "../../src/constants/llm-models";
import {
    LLM_SECRET_KEYS,
    applyLlmSecret,
    lambdaModelProblem,
    prepareLambdaEnvironment,
} from "../../src/slack/lambda-runtime";

describe("Lambda runtime", () => {
    describe("lambdaModelProblem", () => {
        it.each([LLMModel.AZURE_FOUNDRY_CLAUDE, LLMModel.AZURE_OPENAI_CUSTOM, LLMModel.BEDROCK_CLAUDE_4_5_SONNET])(
            "accepts %s",
            (model) => {
                expect(lambdaModelProblem(model)).toBeUndefined();
            },
        );

        it("explains how to fix a model the build does not carry, such as the CLI default", () => {
            const problem = lambdaModelProblem(LLMModel.ANTHROPIC_CLAUDE_4_SONNET);
            expect(problem).toContain("SATENG_MODEL");
            expect(problem).toContain(LLMModel.AZURE_OPENAI_CUSTOM);
        });
    });

    describe("applyLlmSecret", () => {
        it("copies the recognised keys into the environment and reports their names only", () => {
            const env: NodeJS.ProcessEnv = {};
            const applied = applyLlmSecret(
                {
                    AZURE_OPENAI_API_KEY: " key-123 ",
                    AZURE_OPENAI_ENDPOINT: "https://res.cognitiveservices.azure.com",
                    AZURE_OPENAI_DEPLOYMENT_NAME: "gpt-5.4-mini",
                },
                env,
            );

            expect(applied).toEqual(["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT_NAME"]);
            expect(env.AZURE_OPENAI_API_KEY).toBe("key-123");
        });

        it("ignores keys it does not recognise, so the secret cannot rewrite other settings", () => {
            const env: NodeJS.ProcessEnv = {};
            applyLlmSecret({ SLACK_JOB_QUEUE_URL: "https://evil", NODE_OPTIONS: "--require x" }, env);
            expect(env).toEqual({});
        });

        it("lets a variable already set on the function win over the secret", () => {
            const env: NodeJS.ProcessEnv = { AZURE_OPENAI_DEPLOYMENT_NAME: "override" };
            applyLlmSecret({ AZURE_OPENAI_DEPLOYMENT_NAME: "from-secret" }, env);
            expect(env.AZURE_OPENAI_DEPLOYMENT_NAME).toBe("override");
        });

        it("skips empty and non-string values", () => {
            const env: NodeJS.ProcessEnv = {};
            expect(applyLlmSecret({ AZURE_FOUNDRY_API_KEY: "  ", AZURE_FOUNDRY_ENDPOINT: 42 }, env)).toEqual([]);
        });

        it("covers both Azure providers", () => {
            expect(LLM_SECRET_KEYS).toEqual(expect.arrayContaining(["AZURE_FOUNDRY_API_KEY", "AZURE_OPENAI_API_KEY"]));
        });
    });

    it("points the config directory at /tmp unless one is set", () => {
        const original = process.env.SATENG_CONFIG_DIR;
        try {
            delete process.env.SATENG_CONFIG_DIR;
            prepareLambdaEnvironment();
            expect(process.env.SATENG_CONFIG_DIR).toBe("/tmp/sateng");

            process.env.SATENG_CONFIG_DIR = "/custom";
            prepareLambdaEnvironment();
            expect(process.env.SATENG_CONFIG_DIR).toBe("/custom");
        } finally {
            if (original === undefined) delete process.env.SATENG_CONFIG_DIR;
            else process.env.SATENG_CONFIG_DIR = original;
        }
    });
});
