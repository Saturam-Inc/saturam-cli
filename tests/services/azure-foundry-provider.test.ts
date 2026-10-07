import { HumanMessage } from "@langchain/core/messages";
import { LLMModel, isAzureFoundryModel } from "../../src/constants/llm-models";
import { AIProvider, ConfigService, PROVIDER_ENV_VARS } from "../../src/services/config-service";
import { LlmService, azureFoundryAnthropicBaseUrl } from "../../src/services/llm-service";

function mockConfig(providerConfig: Record<string, unknown> | undefined, apiKey = "test-foundry-key"): ConfigService {
    return {
        getApiKey: jest.fn().mockResolvedValue(apiKey),
        getProviderConfig: jest.fn().mockResolvedValue(providerConfig),
        getModel: jest.fn().mockResolvedValue(LLMModel.AZURE_FOUNDRY_CLAUDE),
    } as any;
}

const FOUNDRY_CONFIG = {
    enabled: true,
    apiKey: "test-foundry-key",
    azureEndpoint: "https://my-res.services.ai.azure.com",
    azureDeploymentName: "claude-sonnet-4-5",
};

describe("Claude on Azure AI Foundry provider", () => {
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
            if (key.startsWith("AZURE_FOUNDRY_") || key.startsWith("ANTHROPIC_")) delete process.env[key];
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
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-4-5",
                    content: [{ type: "text", text: "pong" }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 1 },
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }) as any;
    });

    it("routes the sentinel model to the Foundry client", () => {
        expect(isAzureFoundryModel(LLMModel.AZURE_FOUNDRY_CLAUDE)).toBe(true);
        expect(isAzureFoundryModel(LLMModel.AZURE_OPENAI_CUSTOM)).toBe(false);
    });

    it("reads the key from AZURE_FOUNDRY_API_KEY", () => {
        expect(PROVIDER_ENV_VARS[AIProvider.AZURE_FOUNDRY]).toBe("AZURE_FOUNDRY_API_KEY");
    });

    it.each([
        ["https://my-res.services.ai.azure.com", "bare resource URL"],
        ["https://my-res.services.ai.azure.com/", "trailing slash"],
        ["https://my-res.services.ai.azure.com/anthropic", "the /anthropic base"],
        ["https://my-res.services.ai.azure.com/anthropic/v1/messages", "the portal's full target URI"],
    ])("resolves %s (%s) to the Anthropic base URL", (endpoint) => {
        expect(azureFoundryAnthropicBaseUrl(endpoint)).toBe("https://my-res.services.ai.azure.com/anthropic");
    });

    it("calls the Messages API on the resource, with the deployment as the model and the key header", async () => {
        const llm = new LlmService(mockConfig(FOUNDRY_CONFIG), {} as any);

        const reply = await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_FOUNDRY_CLAUDE);

        expect(reply).toBe("pong");
        expect(captured!.url).toBe("https://my-res.services.ai.azure.com/anthropic/v1/messages");
        expect(captured!.headers["x-api-key"]).toBe("test-foundry-key");
        expect(captured!.body.model).toBe("claude-sonnet-4-5");
    });

    it("falls back to env vars when nothing is saved in config — how the Lambda is configured", async () => {
        process.env.AZURE_FOUNDRY_ENDPOINT = "https://env-res.services.ai.azure.com/anthropic/v1/messages";
        process.env.AZURE_FOUNDRY_DEPLOYMENT = "env-claude";
        const llm = new LlmService(mockConfig(undefined), {} as any);

        await llm.prompt([new HumanMessage("ping")], LLMModel.AZURE_FOUNDRY_CLAUDE);

        expect(captured!.url).toBe("https://env-res.services.ai.azure.com/anthropic/v1/messages");
        expect(captured!.body.model).toBe("env-claude");
    });

    it("fails with an actionable message when the endpoint is missing", async () => {
        const llm = new LlmService(mockConfig({ ...FOUNDRY_CONFIG, azureEndpoint: undefined }), {} as any);

        await expect(llm.getModel(LLMModel.AZURE_FOUNDRY_CLAUDE)).rejects.toThrow(/AZURE_FOUNDRY_ENDPOINT/);
    });

    it("fails with an actionable message when the deployment name is missing", async () => {
        const llm = new LlmService(mockConfig({ ...FOUNDRY_CONFIG, azureDeploymentName: undefined }), {} as any);

        await expect(llm.getModel(LLMModel.AZURE_FOUNDRY_CLAUDE)).rejects.toThrow(/AZURE_FOUNDRY_DEPLOYMENT/);
    });

    it("supports tool calling, which the answering agent depends on", async () => {
        const model: any = await new LlmService(mockConfig(FOUNDRY_CONFIG), {} as any).getModel(
            LLMModel.AZURE_FOUNDRY_CLAUDE,
        );
        expect(typeof model.bindTools).toBe("function");
    });
});
