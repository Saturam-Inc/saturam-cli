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

        it("preserves explicit Ollama model even if providerConfig has a custom model configured", async () => {
            mockConfig.getProviderConfig.mockResolvedValue({
                enabled: true,
                model: "qwen2.5-coder:32b",
            });

            expect(await service.resolveModel(LLMModel.OLLAMA_LLAMA3_1)).toBe(LLMModel.OLLAMA_LLAMA3_1);
        });

        it("defaults custom Ollama model to llama3 when not configured", async () => {
            expect(await service.resolveModel(LLMModel.OLLAMA_CUSTOM)).toBe("llama3");
        });

        it("resolves Bedrock Anthropic models with regional prefix (us default)", async () => {
            expect(await service.resolveModel(LLMModel.BEDROCK_CLAUDE_4_6_SONNET)).toBe(
                "us.anthropic.claude-sonnet-4-6",
            );
        });

        it("resolves Bedrock Anthropic models with regional prefix according to configured region", async () => {
            mockConfig.getProviderConfig.mockResolvedValue({
                enabled: true,
                awsRegion: "eu-central-1",
            });

            expect(await service.resolveModel(LLMModel.BEDROCK_CLAUDE_4_6_OPUS)).toBe(
                "eu.anthropic.claude-opus-4-6-v1",
            );
        });

        it("resolves custom Bedrock model from providerConfig", async () => {
            mockConfig.getProviderConfig.mockResolvedValue({
                enabled: true,
                model: "arn:aws:bedrock:us-east-1:123456789012:custom-model/my-fine-tuned-model",
            });

            expect(await service.resolveModel(LLMModel.BEDROCK_CUSTOM)).toBe(
                "arn:aws:bedrock:us-east-1:123456789012:custom-model/my-fine-tuned-model",
            );
        });
    });

    describe("resolveSessionInfo", () => {
        it("resolves both provider and model with a single config read", async () => {
            mockConfig.getModel.mockResolvedValue(LLMModel.ANTHROPIC_CLAUDE_4_SONNET);

            const sessionInfo = await service.resolveSessionInfo();
            expect(sessionInfo).toEqual({
                provider: AIProvider.ANTHROPIC,
                model: LLMModel.ANTHROPIC_CLAUDE_4_SONNET,
            });
            expect(mockConfig.getModel).toHaveBeenCalledTimes(1);
        });

        it("resolves custom model wire name alongside provider", async () => {
            mockConfig.getModel.mockResolvedValue(LLMModel.SELF_HOSTED_CUSTOM);
            mockConfig.getProviderConfig.mockResolvedValue({
                enabled: true,
                endpoint: "http://localhost:8000",
                model: "my-vllm-model",
            });

            const sessionInfo = await service.resolveSessionInfo();
            expect(sessionInfo).toEqual({
                provider: AIProvider.SELF_HOSTED,
                model: "my-vllm-model",
            });
            expect(mockConfig.getModel).toHaveBeenCalledTimes(1);
        });
    });

    describe("prompt tracking", () => {
        it("records failed calls in tracker when model invocation throws", async () => {
            const mockTracker = {
                record: jest.fn(),
            };
            const mockLlmInstance = {
                invoke: jest.fn().mockRejectedValue(new Error("API 429 Rate Limit")),
            };
            jest.spyOn(service, "getModel").mockResolvedValue(mockLlmInstance as any);

            await expect(
                service.prompt([{ content: "test" } as any], LLMModel.ANTHROPIC_CLAUDE_4_SONNET, undefined, {
                    tracker: mockTracker as any,
                    label: "reviewer:architecture",
                }),
            ).rejects.toThrow("API 429 Rate Limit");

            expect(mockTracker.record).toHaveBeenCalledWith("reviewer:architecture (failed)", {
                inputTokens: null,
                outputTokens: null,
            });
        });

        it("extracts usage_metadata correctly for standard models", async () => {
            const mockTracker = {
                record: jest.fn(),
            };
            const mockLlmInstance = {
                invoke: jest.fn().mockResolvedValue({
                    content: "review output",
                    usage_metadata: {
                        input_tokens: 3000,
                        output_tokens: 500,
                        total_tokens: 3500,
                    },
                }),
            };
            jest.spyOn(service, "getModel").mockResolvedValue(mockLlmInstance as any);

            const res = await service.prompt(
                [{ content: "test" } as any],
                LLMModel.ANTHROPIC_CLAUDE_4_SONNET,
                undefined,
                {
                    tracker: mockTracker as any,
                    label: "reviewer:architecture",
                },
            );

            expect(res).toBe("review output");
            expect(mockTracker.record).toHaveBeenCalledWith("reviewer:architecture", {
                inputTokens: 3000,
                outputTokens: 500,
            });
        });

        it("derives output tokens including thinking tokens for Gemini models (total_tokens - input_tokens)", async () => {
            const mockTracker = {
                record: jest.fn(),
            };
            // In Gemini 2.5: prompt=2000, visible candidates=1500, thinking=4500 -> total=8000
            // output_tokens reported by @langchain/google-genai is candidatesTokenCount (1500)
            // But Google bills total (8000), meaning output tokens = 8000 - 2000 = 6000
            const mockLlmInstance = {
                invoke: jest.fn().mockResolvedValue({
                    content: "gemini review output",
                    usage_metadata: {
                        input_tokens: 2000,
                        output_tokens: 1500,
                        total_tokens: 8000,
                    },
                }),
            };
            jest.spyOn(service, "getModel").mockResolvedValue(mockLlmInstance as any);

            const res = await service.prompt([{ content: "test" } as any], LLMModel.GEMINI_2_5_PRO, undefined, {
                tracker: mockTracker as any,
                label: "reviewer:architecture",
            });

            expect(res).toBe("gemini review output");
            expect(mockTracker.record).toHaveBeenCalledWith("reviewer:architecture", {
                inputTokens: 2000,
                outputTokens: 6000, // 8000 - 2000
            });
        });

        it("records null tokens when usage_metadata is omitted", async () => {
            const mockTracker = {
                record: jest.fn(),
            };
            const mockLlmInstance = {
                invoke: jest.fn().mockResolvedValue({
                    content: "ollama review output",
                }),
            };
            jest.spyOn(service, "getModel").mockResolvedValue(mockLlmInstance as any);

            const res = await service.prompt([{ content: "test" } as any], LLMModel.OLLAMA_LLAMA3, undefined, {
                tracker: mockTracker as any,
                label: "reviewer:architecture",
            });

            expect(res).toBe("ollama review output");
            expect(mockTracker.record).toHaveBeenCalledWith("reviewer:architecture", {
                inputTokens: null,
                outputTokens: null,
            });
        });
    });
});
