import { AIProvider } from "./ai-provider";
import { LLMModel } from "./llm-models";

export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
}

/**
 * Standard list pricing rates in USD per 1 Million tokens (1,000,000 tokens).
 * As of 2026-10-05.
 * Sources:
 * - Anthropic: https://anthropic.com/pricing
 * - AWS Bedrock: https://aws.amazon.com/bedrock/pricing/
 * - Google Gemini: https://ai.google.dev/pricing
 * - OpenAI: https://openai.com/api/pricing/
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
 * - xAI / Grok: https://docs.x.ai/docs#models
 */
export const MODEL_PRICING: Partial<Record<LLMModel, ModelPricing>> = {
    // Anthropic (direct API)
    [LLMModel.ANTHROPIC_CLAUDE_4_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.ANTHROPIC_CLAUDE_4_6_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.ANTHROPIC_CLAUDE_4_6_OPUS]: { inputPerMillion: 5.0, outputPerMillion: 25.0 },

    // AWS Bedrock
    [LLMModel.BEDROCK_CLAUDE_3_5_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_3_7_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_3_5_HAIKU]: { inputPerMillion: 0.8, outputPerMillion: 4.0 },
    [LLMModel.BEDROCK_CLAUDE_4_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_4_5_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_4_6_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_4_6_OPUS]: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    [LLMModel.BEDROCK_NOVA_PRO]: { inputPerMillion: 0.8, outputPerMillion: 3.2 },

    // Google Gemini
    [LLMModel.GEMINI_2_5_PRO]: { inputPerMillion: 1.25, outputPerMillion: 10.0 },
    [LLMModel.GEMINI_2_5_FLASH]: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
    [LLMModel.GEMINI_3_1_PRO_PREVIEW]: { inputPerMillion: 2.0, outputPerMillion: 12.0 },
    [LLMModel.GEMINI_3_5_FLASH]: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
    [LLMModel.GEMINI_3_6_FLASH]: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
    [LLMModel.GEMINI_3_7_FLASH]: { inputPerMillion: 0.3, outputPerMillion: 2.5 },

    // OpenAI
    [LLMModel.OPENAI_GPT_4O]: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    [LLMModel.OPENAI_GPT_5]: { inputPerMillion: 1.25, outputPerMillion: 10.0 },
    [LLMModel.OPENAI_O3_MINI]: { inputPerMillion: 1.1, outputPerMillion: 4.4 },

    // Grok / xAI
    [LLMModel.GROK_2]: { inputPerMillion: 2.0, outputPerMillion: 10.0 },

    // DeepSeek
    [LLMModel.DEEPSEEK_CHAT]: { inputPerMillion: 0.14, outputPerMillion: 0.28 },
    [LLMModel.DEEPSEEK_REASONER]: { inputPerMillion: 0.55, outputPerMillion: 2.19 },
};

export function getModelPricing(model: string, provider?: AIProvider): ModelPricing | null {
    if (provider === AIProvider.OLLAMA || provider === AIProvider.SELF_HOSTED) {
        return null;
    }

    if (!model) {
        return null;
    }

    // Direct match
    if (MODEL_PRICING[model as LLMModel]) {
        return MODEL_PRICING[model as LLMModel]!;
    }

    // Strip regional/routing prefixes (e.g. "us.anthropic...", "eu.anthropic...", "ap...")
    const stripped = model.replace(/^(us|eu|ap|global|cr)\./, "").toLowerCase();
    if (MODEL_PRICING[stripped as LLMModel]) {
        return MODEL_PRICING[stripped as LLMModel]!;
    }

    // Check lowercase match against known keys
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
        if (key.toLowerCase() === stripped && pricing) {
            return pricing;
        }
    }

    return null;
}

export function calculateCost(
    model: string,
    inputTokens: number | null,
    outputTokens: number | null,
    provider?: AIProvider,
): number | null {
    if (inputTokens === null || outputTokens === null) {
        return null;
    }
    const pricing = getModelPricing(model, provider);
    if (!pricing) {
        return null;
    }
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
    return inputCost + outputCost;
}
