import { calculateCost, getModelPricing, MODEL_PRICING } from "../../src/constants/model-pricing";
import { LLMModel } from "../../src/constants/llm-models";
import { AIProvider } from "../../src/services/config-service";

describe("ModelPricing", () => {
    describe("getModelPricing", () => {
        it("should return correct pricing for known models", () => {
            const claudePricing = getModelPricing(LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET);
            expect(claudePricing).toEqual({ inputPerMillion: 3.0, outputPerMillion: 15.0 });

            const gpt4oPricing = getModelPricing(LLMModel.OPENAI_GPT_4O);
            expect(gpt4oPricing).toEqual({ inputPerMillion: 2.5, outputPerMillion: 10.0 });

            const geminiPricing = getModelPricing(LLMModel.GEMINI_2_5_FLASH);
            expect(geminiPricing).toEqual({ inputPerMillion: 0.3, outputPerMillion: 2.5 });
        });

        it("should strip regional routing prefixes when matching pricing", () => {
            const bedrockPricing = getModelPricing("us.anthropic.claude-3-7-sonnet-20250219-v1:0");
            expect(bedrockPricing).toEqual({ inputPerMillion: 3.0, outputPerMillion: 15.0 });

            const euPricing = getModelPricing("eu.anthropic.claude-3-5-haiku-20241022-v1:0");
            expect(bedrockPricing).toEqual({ inputPerMillion: 3.0, outputPerMillion: 15.0 });
            expect(euPricing).toEqual({ inputPerMillion: 0.8, outputPerMillion: 4.0 });
        });

        it("should return null for local / self-hosted providers", () => {
            expect(getModelPricing("custom-model", AIProvider.OLLAMA)).toBeNull();
            expect(getModelPricing("my-vllm-endpoint", AIProvider.SELF_HOSTED)).toBeNull();
        });

        it("should return null for unknown or unlisted custom model IDs", () => {
            expect(getModelPricing("custom-claude-3-5-sonnet-custom")).toBeNull();
            expect(getModelPricing("google-flash-preview")).toBeNull();
            expect(getModelPricing("some-unknown-unrecognized-model")).toBeNull();
        });

        it("should pin canonical Bedrock Claude 4.6 model IDs and return accurate pricing", () => {
            expect(LLMModel.BEDROCK_CLAUDE_4_6_SONNET).toBe("anthropic.claude-sonnet-4-6");
            expect(LLMModel.BEDROCK_CLAUDE_4_6_OPUS).toBe("anthropic.claude-opus-4-6-v1");

            const sonnetPricing = getModelPricing(LLMModel.BEDROCK_CLAUDE_4_6_SONNET);
            expect(sonnetPricing).toEqual({ inputPerMillion: 3.0, outputPerMillion: 15.0 });

            const opusPricing = getModelPricing(LLMModel.BEDROCK_CLAUDE_4_6_OPUS);
            expect(opusPricing).toEqual({ inputPerMillion: 5.0, outputPerMillion: 25.0 });
        });
    });

    describe("calculateCost", () => {
        it("should calculate cost accurately for given input and output tokens", () => {
            // Claude Sonnet 4.5: $3.00/1M input, $15.00/1M output
            // 50,000 in = $0.15, 10,000 out = $0.15 -> total $0.30
            const cost = calculateCost(LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET, 50_000, 10_000);
            expect(cost).toBeCloseTo(0.3, 5);
        });

        it("should return null if either token count is null", () => {
            expect(calculateCost(LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET, null, 10_000)).toBeNull();
            expect(calculateCost(LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET, 50_000, null)).toBeNull();
        });

        it("should return null if model pricing cannot be determined", () => {
            expect(calculateCost("totally-unknown-model", 50_000, 10_000)).toBeNull();
        });

        it("should return null for Ollama / Self-hosted runs", () => {
            const cost = calculateCost("custom-model", 100_000, 50_000, AIProvider.OLLAMA);
            expect(cost).toBeNull();
        });
    });
});
