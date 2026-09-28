import { LLMModel } from "../../src/constants/llm-models";
import { AIProvider, type ConfigService } from "../../src/services/config-service";
import { LlmService } from "../../src/services/llm-service";
import type { RemoteCredentialService } from "../../src/services/remote-credential.service";

describe("LlmService resolveProvider and resolveModel", () => {
    let mockConfig: jest.Mocked<ConfigService>;
    let mockRemoteCreds: jest.Mocked<RemoteCredentialService>;
    let service: LlmService;

    beforeEach(() => {
        mockConfig = {
            getModel: jest.fn().mockResolvedValue(LLMModel.ANTHROPIC_CLAUDE_4_SONNET),
            getProviderConfig: jest.fn().mockResolvedValue(undefined),
            getRemoteConfig: jest.fn().mockResolvedValue(undefined),
        } as unknown as jest.Mocked<ConfigService>;

        mockRemoteCreds = {
            getCredentials: jest.fn(),
        } as unknown as jest.Mocked<RemoteCredentialService>;

        service = new LlmService(mockConfig, mockRemoteCreds);
        delete process.env.SELF_HOSTED_MODEL;
    });

    describe("resolveProvider", () => {
        it("resolves all provider types accurately", async () => {
            expect(await service.resolveProvider(LLMModel.ANTHROPIC_CLAUDE_4_SONNET)).toBe(AIProvider.ANTHROPIC);
            expect(await service.resolveProvider(LLMModel.BEDROCK_CLAUDE_4_SONNET)).toBe(AIProvider.BEDROCK);
            expect(await service.resolveProvider(LLMModel.GEMINI_2_5_PRO)).toBe(AIProvider.GOOGLE);
            expect(await service.resolveProvider(LLMModel.OPENAI_GPT_4O)).toBe(AIProvider.OPENAI);
            expect(await service.resolveProvider(LLMModel.GROK_2)).toBe(AIProvider.XAI);
            expect(await service.resolveProvider(LLMModel.DEEPSEEK_CHAT)).toBe(AIProvider.DEEPSEEK);
            expect(await service.resolveProvider(LLMModel.OLLAMA_LLAMA3)).toBe(AIProvider.OLLAMA);
            expect(await service.resolveProvider(LLMModel.SELF_HOSTED_CUSTOM)).toBe(AIProvider.SELF_HOSTED);
        });

        it("defaults to config model when model parameter is omitted", async () => {
            mockConfig.getModel.mockResolvedValue(LLMModel.OPENAI_GPT_4O);
            expect(await service.resolveProvider()).toBe(AIProvider.OPENAI);
        });
    });

    describe("resolveModel", () => {
        it("returns the standard model string for standard models", async () => {
            expect(await service.resolveModel(LLMModel.ANTHROPIC_CLAUDE_4_SONNET)).toBe(
                LLMModel.ANTHROPIC_CLAUDE_4_SONNET,
            );
        });

        it("resolves custom self-hosted model name from providerConfig", async () => {
            mockConfig.getProviderConfig.mockResolvedValue({
                enabled: true,
                endpoint: "http://localhost:8000",
                model: "my-custom-qwen-72b",
            });

            expect(await service.resolveModel(LLMModel.SELF_HOSTED_CUSTOM)).toBe("my-custom-qwen-72b");
        });

        it("resolves custom self-hosted model from env var when not in config", async () => {
            process.env.SELF_HOSTED_MODEL = "env-model-llama3.3";
            expect(await service.resolveModel(LLMModel.SELF_HOSTED_CUSTOM)).toBe("env-model-llama3.3");
        });

        it("resolves custom Ollama model name from providerConfig", async () => {
            mockConfig.getProviderConfig.mockResolvedValue({
                enabled: true,
                model: "custom-codellama",
            });

            expect(await service.resolveModel(LLMModel.OLLAMA_CUSTOM)).toBe("custom-codellama");
        });

        it("defaults custom Ollama model to llama3 when not configured", async () => {
            expect(await service.resolveModel(LLMModel.OLLAMA_CUSTOM)).toBe("llama3");
        });
    });
});
