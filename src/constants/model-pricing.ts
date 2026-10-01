import { AIProvider } from "../services/config-service";
import { LLMModel } from "./llm-models";

export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
}

/**
 * Standard pricing rates in USD per 1 Million tokens (1,000,000 tokens).
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
    // Anthropic (direct API)
    [LLMModel.ANTHROPIC_CLAUDE_4_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.ANTHROPIC_CLAUDE_4_6_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.ANTHROPIC_CLAUDE_4_6_OPUS]: { inputPerMillion: 15.0, outputPerMillion: 75.0 },

    // AWS Bedrock
    [LLMModel.BEDROCK_CLAUDE_3_5_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_3_7_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_3_5_HAIKU]: { inputPerMillion: 0.8, outputPerMillion: 4.0 },
    [LLMModel.BEDROCK_CLAUDE_4_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_4_5_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_4_6_SONNET]: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    [LLMModel.BEDROCK_CLAUDE_4_6_OPUS]: { inputPerMillion: 15.0, outputPerMillion: 75.0 },
    [LLMModel.BEDROCK_NOVA_PRO]: { inputPerMillion: 0.8, outputPerMillion: 3.2 },

    // Google Gemini
    [LLMModel.GEMINI_2_5_PRO]: { inputPerMillion: 1.25, outputPerMillion: 5.0 },
    [LLMModel.GEMINI_2_5_FLASH]: { inputPerMillion: 0.075, outputPerMillion: 0.3 },
    [LLMModel.GEMINI_3_PRO]: { inputPerMillion: 1.25, outputPerMillion: 5.0 },
    [LLMModel.GEMINI_3_FLASH]: { inputPerMillion: 0.075, outputPerMillion: 0.3 },

    // OpenAI
    [LLMModel.OPENAI_GPT_4O]: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    [LLMModel.OPENAI_GPT_5]: { inputPerMillion: 5.0, outputPerMillion: 15.0 },
    [LLMModel.OPENAI_O3_MINI]: { inputPerMillion: 1.1, outputPerMillion: 4.4 },
    [LLMModel.OPENAI_GPT_OSS_120B]: { inputPerMillion: 0.0, outputPerMillion: 0.0 },
    [LLMModel.OPENAI_GPT_OSS_20B]: { inputPerMillion: 0.0, outputPerMillion: 0.0 },
    [LLMModel.OPENAI_QWEN3_NEXT_80B_A3B_INSTRUCT]: { inputPerMillion: 0.0, outputPerMillion: 0.0 },
    [LLMModel.OPENAI_GEMMA_4_26B_A4B_IT]: { inputPerMillion: 0.0, outputPerMillion: 0.0 },
    [LLMModel.OPENAI_GEMMA_4_31B_IT]: { inputPerMillion: 0.0, outputPerMillion: 0.0 },
    [LLMModel.OPENAI_LLAMA_3_3_70B_INSTRUCT]: { inputPerMillion: 0.0, outputPerMillion: 0.0 },

    // Grok / xAI
    [LLMModel.GROK_2]: { inputPerMillion: 2.0, outputPerMillion: 10.0 },

    // DeepSeek
    [LLMModel.DEEPSEEK_CHAT]: { inputPerMillion: 0.14, outputPerMillion: 0.28 },
    [LLMModel.DEEPSEEK_REASONER]: { inputPerMillion: 0.55, outputPerMillion: 2.19 },

    // Ollama & Self-hosted
    [LLMModel.OLLAMA_LLAMA3]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_LLAMA3_1]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_LLAMA3_2]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_CODELLAMA]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_MISTRAL]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_MIXTRAL]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_DEEPSEEK_CODER_V2]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_QWEN2_5_CODER]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_GEMMA2]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_PHI3]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.OLLAMA_CUSTOM]: { inputPerMillion: 0, outputPerMillion: 0 },
    [LLMModel.SELF_HOSTED_CUSTOM]: { inputPerMillion: 0, outputPerMillion: 0 },
};

export function getModelPricing(model: string, provider?: AIProvider): ModelPricing | null {
    if (provider === AIProvider.OLLAMA || provider === AIProvider.SELF_HOSTED) {
        return { inputPerMillion: 0, outputPerMillion: 0 };
    }

    if (!model) {
        return null;
    }

    // Direct match
    if (MODEL_PRICING[model]) {
        return MODEL_PRICING[model];
    }

    // Strip regional/routing prefixes (e.g. "us.anthropic...", "eu.anthropic...", "ap...")
    const stripped = model.replace(/^(us|eu|ap|global|cr)\./, "").toLowerCase();
    if (MODEL_PRICING[stripped]) {
        return MODEL_PRICING[stripped];
    }

    // Check lowercase match against known keys
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
        if (key.toLowerCase() === stripped) {
            return pricing;
        }
    }

    // Substring / family fallback
    if (stripped.includes("haiku")) return { inputPerMillion: 0.8, outputPerMillion: 4.0 };
    if (stripped.includes("opus")) return { inputPerMillion: 15.0, outputPerMillion: 75.0 };
    if (stripped.includes("sonnet") || stripped.includes("claude")) return { inputPerMillion: 3.0, outputPerMillion: 15.0 };
    if (stripped.includes("flash")) return { inputPerMillion: 0.075, outputPerMillion: 0.3 };
    if (stripped.includes("gemini") && stripped.includes("pro")) return { inputPerMillion: 1.25, outputPerMillion: 5.0 };
    if (stripped.includes("gpt-4o")) return { inputPerMillion: 2.5, outputPerMillion: 10.0 };
    if (stripped.includes("gpt-5")) return { inputPerMillion: 5.0, outputPerMillion: 15.0 };
    if (stripped.includes("o3-mini")) return { inputPerMillion: 1.1, outputPerMillion: 4.4 };
    if (stripped.includes("deepseek-reasoner")) return { inputPerMillion: 0.55, outputPerMillion: 2.19 };
    if (stripped.includes("deepseek")) return { inputPerMillion: 0.14, outputPerMillion: 0.28 };
    if (stripped.includes("grok")) return { inputPerMillion: 2.0, outputPerMillion: 10.0 };
    if (stripped.includes("nova-pro")) return { inputPerMillion: 0.8, outputPerMillion: 3.2 };

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
