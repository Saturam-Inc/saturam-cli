import { HumanMessage } from "@langchain/core/messages";
import { LLMModel, isAzureOpenAIModel } from "../../src/constants/llm-models";
import { AIProvider, ConfigService, PROVIDER_ENV_VARS } from "../../src/services/config-service";
import { LlmService, azureOpenAIAcceptsTemperature, parseAzureOpenAITarget } from "../../src/services/llm-service";

function mockConfig(providerConfig: Record<string, unknown> | undefined, apiKey = "test-azure-key"): ConfigService {
    return {
        getApiKey: jest.fn().mockResolvedValue(apiKey),
        getProviderConfig: jest.fn().mockResolvedValue(providerConfig),
        getModel: jest.fn().mockResolvedValue(LLMModel.AZURE_OPENAI_CUSTOM),
    } as any;
}

const AZURE_CONFIG = {
    enabled: true,
    apiKey: "test-azure-key",
    azureEndpoint: "https://my-res.openai.azure.com",
    azureDeploymentName: "gpt-4o-prod",
    azureApiVersion: "2024-10-21",
};

describe("Azure OpenAI provider", () => {
    let originalEnv: NodeJS.ProcessEnv;
    let originalFetch: typeof globalThis.fetch;
    let captured: { url: string; headers: Record<string, string>; body: any } | undefined;

    beforeAll(() => {
        originalEnv = { ...process.env };
        originalFetch = globalThis.fetch;
    });

    afterAll(() => {
        process.env = originalEnv;
        globalThis.fetch = originalFetch;
    });

    beforeEach(() => {
        process.env = { ...originalEnv };
        for (const key of Object.keys(process.env)) {
            if (key.startsWith("AZURE_OPENAI_")) delete process.env[key];
        }
        captured = undefined;

        globalThis.fetch = jest.fn(async (input: any, init: any) => {
            const headers: Record<string, string> = {};
            new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
            captured = {
                url: typeof input === "string" ? input : String(input?.url ?? input),
                headers,
                body: init?.body ? JSON.parse(String(init.body)) : undefined,
            };
            return new Response(
                JSON.stringify({
                    id: "1",
                    object: "chat.completion",
                    created: 0,
                    model: "gpt-4o",
                    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }) as any;
    });

    it("routes the sentinel model to the Azure client", () => {
        expect(isAzureOpenAIModel(LLMModel.AZURE_OPENAI_CUSTOM)).toBe(true);
        expect(isAzureOpenAIModel(LLMModel.OPENAI_GPT_4O)).toBe(false);
    });

    it("reads the key from AZURE_OPENAI_API_KEY", () => {
        expect(PROVIDER_ENV_VARS[AIProvider.AZURE_OPENAI]).toBe("AZURE_OPENAI_API_KEY");
    });

    it("targets the deployment URL with api-version and the api-key header", async () => {
        const llm = new LlmService(mockConfig(AZURE_CONFIG), {} as any);

        const reply = await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM);

        expect(reply).toBe("pong");
        expect(captured!.url).toBe(
            "https://my-res.openai.azure.com/openai/deployments/gpt-4o-prod/chat/completions?api-version=2024-10-21",
        );
        // Azure key auth uses the api-key header; Bearer is only for Entra ID tokens.
        expect(captured!.headers["api-key"]).toBe("test-azure-key");
    });

    it("strips a trailing slash so the deployment path is not doubled", async () => {
        const llm = new LlmService(
            mockConfig({ ...AZURE_CONFIG, azureEndpoint: "https://my-res.openai.azure.com/" }),
            {} as any,
        );

        await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM);

        expect(captured!.url).not.toContain("//openai/deployments");
    });

    it("falls back to env vars when nothing is saved in config", async () => {
        process.env.AZURE_OPENAI_ENDPOINT = "https://env-res.openai.azure.com";
        process.env.AZURE_OPENAI_DEPLOYMENT_NAME = "env-deployment";
        process.env.AZURE_OPENAI_API_VERSION = "2025-01-01";
        const llm = new LlmService(mockConfig(undefined), {} as any);

        await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM);

        expect(captured!.url).toBe(
            "https://env-res.openai.azure.com/openai/deployments/env-deployment/chat/completions?api-version=2025-01-01",
        );
    });

    it("defaults the API version when none is configured", async () => {
        const llm = new LlmService(mockConfig({ ...AZURE_CONFIG, azureApiVersion: undefined }), {} as any);

        await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM);

        expect(captured!.url).toContain("api-version=2024-10-21");
    });

    it("fails with an actionable message when the endpoint is missing", async () => {
        const llm = new LlmService(mockConfig({ ...AZURE_CONFIG, azureEndpoint: undefined }), {} as any);

        await expect(llm.getModel(LLMModel.AZURE_OPENAI_CUSTOM)).rejects.toThrow(/AZURE_OPENAI_ENDPOINT/);
    });

    it("fails with an actionable message when the deployment name is missing", async () => {
        const llm = new LlmService(mockConfig({ ...AZURE_CONFIG, azureDeploymentName: undefined }), {} as any);

        await expect(llm.getModel(LLMModel.AZURE_OPENAI_CUSTOM)).rejects.toThrow(/AZURE_OPENAI_DEPLOYMENT_NAME/);
    });

    describe("a Foundry GPT-5-family deployment configured from the portal's Target URI", () => {
        const TARGET_URI =
            "https://my-res.cognitiveservices.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-04-01-preview";

        beforeEach(() => {
            delete process.env.AZURE_OPENAI_SUPPORTS_TEMPERATURE;
        });

        it("takes the endpoint, deployment and API version from the Target URI", async () => {
            process.env.AZURE_OPENAI_ENDPOINT = TARGET_URI;
            const llm = new LlmService(mockConfig(undefined), {} as any);

            await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM);

            expect(captured!.url).toBe(TARGET_URI);
        });

        it("lets explicitly configured values win over what the Target URI carries", async () => {
            process.env.AZURE_OPENAI_ENDPOINT = TARGET_URI;
            process.env.AZURE_OPENAI_DEPLOYMENT_NAME = "other-deployment";
            process.env.AZURE_OPENAI_API_VERSION = "2025-06-01";
            const llm = new LlmService(mockConfig(undefined), {} as any);

            await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM);

            expect(captured!.url).toBe(
                "https://my-res.cognitiveservices.azure.com/openai/deployments/other-deployment/chat/completions?api-version=2025-06-01",
            );
        });

        it("sends no temperature, which GPT-5-family models reject", async () => {
            process.env.AZURE_OPENAI_ENDPOINT = TARGET_URI;
            const llm = new LlmService(mockConfig(undefined), {} as any);

            await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM, { temperature: 0.3 });

            expect(captured!.body).not.toHaveProperty("temperature");
        });

        it("still sends the temperature for a model that accepts one", async () => {
            const llm = new LlmService(mockConfig(AZURE_CONFIG), {} as any);

            await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM, { temperature: 0.3 });

            expect(captured!.body.temperature).toBe(0.3);
        });
    });

    describe("parseAzureOpenAITarget", () => {
        it.each([
            ["https://my-res.openai.azure.com", {}],
            ["https://my-res.openai.azure.com/", {}],
            [
                "https://my-res.cognitiveservices.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-04-01-preview",
                { deploymentName: "gpt-5.4-mini", apiVersion: "2025-04-01-preview" },
            ],
            ["https://my-res.services.ai.azure.com/openai/v1/", {}],
        ])("reads %s", (uri, expected) => {
            const parsed = parseAzureOpenAITarget(uri);
            expect(parsed.endpoint).toBe(new URL(uri).origin);
            expect(parsed).toMatchObject(expected);
        });
    });

    describe("azureOpenAIAcceptsTemperature", () => {
        it.each([
            ["gpt-5.4-mini", false],
            ["gpt-5", false],
            ["o3-mini", false],
            ["gpt-4o-prod", true],
            ["gpt-4.1", true],
        ])("%s → %s", (deployment, expected) => {
            expect(azureOpenAIAcceptsTemperature(deployment, undefined)).toBe(expected);
        });

        it("defers to an explicit override for a deployment whose name hides the model", () => {
            expect(azureOpenAIAcceptsTemperature("my-chat-bot", "false")).toBe(false);
            expect(azureOpenAIAcceptsTemperature("gpt-5-chat", "true")).toBe(true);
        });
    });

    it("gives up after a bounded number of retries instead of LangChain's ~90 s default", async () => {
        (globalThis.fetch as jest.Mock).mockImplementation(async () => new Response("busy", { status: 429 }));
        const llm = new LlmService(mockConfig(AZURE_CONFIG), {} as any);
        const started = Date.now();

        await expect(llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_OPENAI_CUSTOM)).rejects.toThrow();

        expect((globalThis.fetch as jest.Mock).mock.calls.length).toBeLessThanOrEqual(3);
        expect(Date.now() - started).toBeLessThan(15_000);
    }, 20_000);
});
