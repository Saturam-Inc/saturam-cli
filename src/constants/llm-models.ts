import type { ChatAnthropic } from "@langchain/anthropic";
import type { ChatBedrockConverse } from "@langchain/aws";
import type { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { ChatOllama } from "@langchain/ollama";
import type { ChatOpenAI } from "@langchain/openai";
import type { ChatXAI } from "@langchain/xai";

export type LLMOptions = {
    temperature?: number;
};

export enum LLMModel {
    // Anthropic (direct API)
    ANTHROPIC_CLAUDE_4_SONNET = "claude-4-sonnet-latest",
    ANTHROPIC_CLAUDE_4_5_SONNET = "claude-sonnet-4-5-20250929",
    ANTHROPIC_CLAUDE_4_6_OPUS = "claude-opus-4-6",

    // AWS Bedrock
    BEDROCK_CLAUDE_4_SONNET = "us.anthropic.claude-sonnet-4-20250514-v1:0",
    BEDROCK_CLAUDE_4_5_SONNET = "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    BEDROCK_CLAUDE_4_6_OPUS = "us.anthropic.claude-opus-4-6-v1",
    BEDROCK_NOVA_PRO = "amazon.nova-pro-v1:0",

    // Google Gemini
    GEMINI_2_5_PRO = "gemini-2.5-pro",
    GEMINI_2_5_FLASH = "gemini-2.5-flash",
    GEMINI_3_PRO = "gemini-3-pro",
    GEMINI_3_FLASH = "gemini-3-flash",

    // OpenAI
    OPENAI_GPT_4O = "gpt-4o",
    OPENAI_GPT_5 = "gpt-5",
    OPENAI_O3_MINI = "o3-mini",

    // Grok
    GROK_2 = "grok-2-1212",

    // DeepSeek
    DEEPSEEK_CHAT = "deepseek-chat",
    DEEPSEEK_REASONER = "deepseek-reasoner",

    // Ollama (local)
    OLLAMA_LLAMA3 = "llama3",
    OLLAMA_LLAMA3_1 = "llama3.1",
    OLLAMA_LLAMA3_2 = "llama3.2",
    OLLAMA_CODELLAMA = "codellama",
    OLLAMA_MISTRAL = "mistral",
    OLLAMA_MIXTRAL = "mixtral",
    OLLAMA_DEEPSEEK_CODER_V2 = "deepseek-coder-v2",
    OLLAMA_QWEN2_5_CODER = "qwen2.5-coder",
    OLLAMA_GEMMA2 = "gemma2",
    OLLAMA_PHI3 = "phi3",
    OLLAMA_CUSTOM = "ollama-custom",
}

export type ChatModel = ChatAnthropic | ChatBedrockConverse | ChatGoogleGenerativeAI | ChatOpenAI | ChatXAI | ChatOllama;

export const MODEL_CONTEXT_WINDOWS: Record<LLMModel, number> = {
    // Anthropic
    [LLMModel.ANTHROPIC_CLAUDE_4_SONNET]: 200000,
    [LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET]: 200000,
    [LLMModel.ANTHROPIC_CLAUDE_4_6_OPUS]: 1000000,
    // Bedrock
    [LLMModel.BEDROCK_CLAUDE_4_SONNET]: 200000,
    [LLMModel.BEDROCK_CLAUDE_4_5_SONNET]: 200000,
    [LLMModel.BEDROCK_CLAUDE_4_6_OPUS]: 1000000,
    [LLMModel.BEDROCK_NOVA_PRO]: 300000,
    // Gemini
    [LLMModel.GEMINI_2_5_PRO]: 1000000,
    [LLMModel.GEMINI_2_5_FLASH]: 1000000,
    [LLMModel.GEMINI_3_PRO]: 1000000,
    [LLMModel.GEMINI_3_FLASH]: 1000000,
    // OpenAI
    [LLMModel.OPENAI_GPT_4O]: 128000,
    [LLMModel.OPENAI_GPT_5]: 128000,
    [LLMModel.OPENAI_O3_MINI]: 128000,
    // Grok
    [LLMModel.GROK_2]: 131072,
    // DeepSeek
    [LLMModel.DEEPSEEK_CHAT]: 64000,
    [LLMModel.DEEPSEEK_REASONER]: 64000,
    // Ollama (varies by model, these are defaults)
    [LLMModel.OLLAMA_LLAMA3]: 8192,
    [LLMModel.OLLAMA_LLAMA3_1]: 131072,
    [LLMModel.OLLAMA_LLAMA3_2]: 131072,
    [LLMModel.OLLAMA_CODELLAMA]: 16384,
    [LLMModel.OLLAMA_MISTRAL]: 32768,
    [LLMModel.OLLAMA_MIXTRAL]: 32768,
    [LLMModel.OLLAMA_DEEPSEEK_CODER_V2]: 128000,
    [LLMModel.OLLAMA_QWEN2_5_CODER]: 32768,
    [LLMModel.OLLAMA_GEMMA2]: 8192,
    [LLMModel.OLLAMA_PHI3]: 128000,
    [LLMModel.OLLAMA_CUSTOM]: 8192,
};

export function getModelContextWindow(model: LLMModel): number {
    return MODEL_CONTEXT_WINDOWS[model] ?? 8192;
}

// --- Model groupings ---

const ANTHROPIC_MODELS = new Set([LLMModel.ANTHROPIC_CLAUDE_4_SONNET, LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET, LLMModel.ANTHROPIC_CLAUDE_4_6_OPUS]);
const BEDROCK_MODELS = new Set([LLMModel.BEDROCK_CLAUDE_4_SONNET, LLMModel.BEDROCK_CLAUDE_4_5_SONNET, LLMModel.BEDROCK_CLAUDE_4_6_OPUS, LLMModel.BEDROCK_NOVA_PRO]);
const GEMINI_MODELS = new Set([LLMModel.GEMINI_2_5_PRO, LLMModel.GEMINI_2_5_FLASH, LLMModel.GEMINI_3_PRO, LLMModel.GEMINI_3_FLASH]);
const OPENAI_MODELS = new Set([LLMModel.OPENAI_GPT_4O, LLMModel.OPENAI_GPT_5, LLMModel.OPENAI_O3_MINI]);
const GROK_MODELS = new Set([LLMModel.GROK_2]);
const DEEPSEEK_MODELS = new Set([LLMModel.DEEPSEEK_CHAT, LLMModel.DEEPSEEK_REASONER]);
const OLLAMA_MODELS = new Set([
    LLMModel.OLLAMA_LLAMA3, LLMModel.OLLAMA_LLAMA3_1, LLMModel.OLLAMA_LLAMA3_2,
    LLMModel.OLLAMA_CODELLAMA, LLMModel.OLLAMA_MISTRAL, LLMModel.OLLAMA_MIXTRAL,
    LLMModel.OLLAMA_DEEPSEEK_CODER_V2, LLMModel.OLLAMA_QWEN2_5_CODER,
    LLMModel.OLLAMA_GEMMA2, LLMModel.OLLAMA_PHI3, LLMModel.OLLAMA_CUSTOM,
]);

export function isAnthropicModel(model: LLMModel): boolean {
    return ANTHROPIC_MODELS.has(model);
}

export function isBedrockModel(model: LLMModel): boolean {
    return BEDROCK_MODELS.has(model);
}

export function isGeminiModel(model: LLMModel): boolean {
    return GEMINI_MODELS.has(model);
}

export function isOpenAIModel(model: LLMModel): boolean {
    return OPENAI_MODELS.has(model);
}

export function isGrokModel(model: LLMModel): boolean {
    return GROK_MODELS.has(model);
}

export function isDeepSeekModel(model: LLMModel): boolean {
    return DEEPSEEK_MODELS.has(model);
}

export function isOllamaModel(model: LLMModel): boolean {
    return OLLAMA_MODELS.has(model);
}
